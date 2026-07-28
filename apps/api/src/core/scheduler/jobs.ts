/**
 * Registro de tareas del scheduler: aqui se decide QUE corre el robot, con QUE
 * intervalo y bajo QUE candado. El motor (`scheduler.ts`) es generico; este
 * archivo es el unico que conoce el dominio.
 *
 * Todas las tareas son de sincronizacion y comparten la misma forma: corren en
 * segundo plano cada cierto intervalo y NO deben solaparse entre instancias. Por
 * eso se registran con `registerSyncJob`, que envuelve el trabajo en su advisory
 * lock (ver `with-lock.ts`). Cada tarea trae ademas:
 *   - su intervalo, desde la config (variable de entorno propia): distintas
 *     tareas pueden tener distintas duraciones;
 *   - su clave de candado propia (`JobLock`): dos instancias de la MISMA tarea
 *     no se solapan, pero tareas DISTINTAS si pueden correr a la vez.
 *
 * Para agregar una tarea nueva: (1) una clave en `JobLock`, (2) su intervalo en
 * `config`, (3) una llamada a `registerSyncJob` en `registerJobs`.
 */
import { and, asc, eq } from 'drizzle-orm';
import { Principal, Role, UserStatus } from '@courier/shared';
import type { Session } from '@courier/shared';
import { config } from '../config';
import { db } from '../db';
import { isHelgaEnabled } from '../../integrations/helga/helga.client';
import { users } from '../../modules/auth/auth.schema';
import { authService } from '../../modules/auth/auth.service';
import { providerDiscoveryService } from '../../modules/shipments/provider-discovery.service';
import { providerSyncService } from '../../modules/shipments/provider-sync.service';
import { shipmentsService } from '../../modules/shipments/shipments.service';
import { Scheduler } from './scheduler';
import { withLock } from './with-lock';

/**
 * Clave de advisory lock por tarea. Numeros arbitrarios pero FIJOS y UNICOS: no
 * reutilizar una clave al agregar una tarea (dos tareas con la misma clave se
 * excluirian mutuamente sin razon). El offset 48xx solo evita chocar con
 * cualquier otro advisory lock que se use en el futuro.
 */
const JobLock = {
  ProviderSync: 4801,
  ClientLinkReconcile: 4802,
  PrealertReconcile: 4803,
  ProviderDiscovery: 4804,
  // Reservado para la tarea de sincronizacion pendiente de definir:
  // Task5: 4805,
} as const;

/** Definicion de una tarea de sincronizacion, tal como se registra. */
interface SyncJobDef {
  /** Nombre corto para los logs; unico dentro del scheduler. */
  name: string;
  /** Intervalo: duracion legible ("30m", "2h", "1d"). Sale de la config. */
  every: string;
  /** Clave de advisory lock propia de esta tarea (de `JobLock`). */
  lockKey: number;
  /** El trabajo en si. */
  run: () => Promise<void>;
}

/** Registra una tarea de sincronizacion envuelta en su candado. */
function registerSyncJob(scheduler: Scheduler, def: SyncJobDef): void {
  scheduler.register({
    name: def.name,
    every: def.every,
    handler: withLock(def.lockKey, def.name, def.run),
  });
}

/**
 * Sesion sintetica para las tareas de fondo. La sincronizacion del proveedor
 * escribe eventos de historial con `createdBy`, que es una FK a un usuario real;
 * por eso el robot actua "como" el staff mas antiguo activo en vez de con un id
 * inventado (que romperia la FK). `sessionId: 'system'` deja claro en cualquier
 * traza que el movimiento no lo hizo una persona sino el robot.
 *
 * Devuelve null si todavia no hay ningun staff activo (base recien sembrada sin
 * admin): la tarea que la use debe omitirse, no fallar.
 */
async function resolveSystemSession(): Promise<Session | null> {
  const [staff] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.principal, Principal.Staff), eq(users.status, UserStatus.Activo)))
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (!staff) return null;

  return {
    sessionId: 'system',
    userId: staff.id,
    principal: Principal.Staff,
    role: staff.role as Role,
  };
}

/**
 * Registra las tareas activas en el scheduler dado. Solo agrega las que tienen
 * sentido segun la config (p. ej. la sincronizacion con Helga no se agenda si la
 * integracion esta apagada: correria en vacio ensuciando el log cada intervalo).
 */
export function registerJobs(scheduler: Scheduler): void {
  // --- Sincronizacion de estados con el proveedor Helga (docs/13) ---
  // Reemplaza el disparo manual de POST /shipments/sync-provider.
  //
  // La condicion es `isHelgaEnabled()` (o sea, `HELGA_MODE` distinto de `off`) y
  // no solo el modo `on`: con el proveedor SIMULADO estas cuatro tareas tambien
  // tienen que correr, porque el robot es justamente lo que se quiere probar. Con
  // `HELGA_MODE=off` no se agendan, que correrian en vacio ensuciando el log cada
  // intervalo.
  if (isHelgaEnabled()) {
    registerSyncJob(scheduler, {
      name: 'provider-sync',
      every: config.ROBOT_PROVIDER_SYNC_EVERY,
      lockKey: JobLock.ProviderSync,
      run: async () => {
        const session = await resolveSystemSession();
        if (!session) {
          console.warn('[scheduler] provider-sync: no hay staff activo; se omite.');
          return;
        }
        const r = await providerSyncService.run(session);
        console.log(
          `[scheduler] provider-sync: revisados=${r.checked} avanzados=${r.advanced} ` +
            `incidencias=${r.incidents.length} desconocidos=${r.unknownStates.length} ` +
            `casillero_no_coincide=${r.lockerMismatches.length}`,
        );
      },
    });

    // --- Reconciliacion del enlace de casilleros (docs/13) ---
    // Reintenta enlazar con Helga los casilleros que quedaron 'pending'/'failed'
    // (el registro no bloquea si el proveedor falla) y actualiza la bandera.
    registerSyncJob(scheduler, {
      name: 'helga-link-reconcile',
      every: config.ROBOT_LOCKER_LINK_RETRY_EVERY,
      lockKey: JobLock.ClientLinkReconcile,
      run: async () => {
        const r = await authService.reconcileProviderLinks();
        console.log(
          `[scheduler] helga-link-reconcile: revisados=${r.checked} enlazados=${r.synced} fallidos=${r.failed}`,
        );
      },
    });

    // --- Reconciliacion de prealertas ---
    // Reenvia a Helga las prealertas 'pending'/'failed' cuyo casillero ya esta
    // enlazado, y actualiza la bandera.
    registerSyncJob(scheduler, {
      name: 'helga-prealert-reconcile',
      every: config.ROBOT_PREALERT_RETRY_EVERY,
      lockKey: JobLock.PrealertReconcile,
      run: async () => {
        const r = await shipmentsService.reconcilePrealerts();
        console.log(
          `[scheduler] helga-prealert-reconcile: revisados=${r.checked} prealertados=${r.synced} fallidos=${r.failed}`,
        );
      },
    });

    // --- Descubrimiento de paquetes creados directo en Helga (flujo 2, docs/13 §3.3) ---
    // El camino inverso al resto: los demas jobs empujan hacia el proveedor o
    // preguntan por lo que ya conocemos; este trae lo que NO conocemos.
    //
    // OJO CON EL INTERVALO: la op. E solo lista paquetes en DIGITADO. Lo que
    // avance antes de una corrida sale del listado y ya no se puede recuperar
    // (hay que cargarlo a mano). Si `creados` sube y baja de forma erratica o
    // aparecen reclamos de paquetes que nunca entraron, el intervalo es largo.
    registerSyncJob(scheduler, {
      name: 'helga-discovery',
      every: config.ROBOT_PACKAGE_DISCOVERY_EVERY,
      lockKey: JobLock.ProviderDiscovery,
      run: async () => {
        const session = await resolveSystemSession();
        if (!session) {
          console.warn('[scheduler] helga-discovery: no hay staff activo; se omite.');
          return;
        }
        const r = await providerDiscoveryService.run(session);
        console.log(
          `[scheduler] helga-discovery: listados=${r.fetched} creados=${r.created} ` +
            `conocidos=${r.known} ajenos=${r.foreign} sin_tracking=${r.invalid} fallidos=${r.failed}`,
        );
      },
    });
  }

  // --- Falta 1 tarea de sincronizacion por definir (la indicara el usuario) ---
}

/**
 * Crea el scheduler con sus tareas ya registradas, o null si no hay nada que
 * agendar (o el robot esta apagado). `main.ts` decide si arrancarlo.
 */
export function createScheduler(): Scheduler | null {
  if (!config.ROBOT_ENABLED) {
    return null;
  }
  const scheduler = new Scheduler();
  registerJobs(scheduler);
  if (scheduler.size === 0) {
    console.warn(
      '[scheduler] ROBOT_ENABLED=true pero no hay ninguna tarea que agendar. Hoy todas las ' +
        'tareas son del proveedor, así que esto suele significar HELGA_MODE=off.',
    );
    return null;
  }
  return scheduler;
}
