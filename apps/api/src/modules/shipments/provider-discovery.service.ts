/**
 * Descubrimiento de paquetes creados directamente en Helga (flujo 2, docs/13 §3.3).
 *
 * El flujo 1 (el principal) va de nosotros hacia el proveedor: alguien crea el
 * tramite en nuestra API y se lo avisamos a Helga con la op. C. Este es el camino
 * inverso: alguien creo el paquete directo en la interfaz de Helga y se salto
 * nuestro sistema. Para nuestra BD ese paquete no existe, y como la op. B busca
 * POR TRACKING, no hay forma de preguntarle al proveedor por algo que no sabemos
 * que existe. La op. E es el unico canal de descubrimiento: lista los paquetes
 * disponibles de toda la cuenta consolidada, cada fila con su `destinatario_id`.
 *
 * LO INICIA EL ROBOT, NUNCA UNA PERSONA. No hay endpoint ni pantalla: se agenda en
 * `core/scheduler/jobs.ts` cada `HELGA_DISCOVERY_INTERVAL`.
 *
 * Cinco decisiones que viven aqui:
 *
 * 1. VENTANA DE CAPTURA. La op. E solo devuelve paquetes en DIGITADO. En cuanto
 *    Helga los mueve a AGRUPADA salen del listado y no hay endpoint que recupere
 *    el historico. Un paquete que avanza sin haber sido capturado es un PAQUETE
 *    PERDIDO y se carga a mano despues: no se intenta recuperarlo automaticamente.
 *    Por eso el intervalo del robot debe ser mas corto que el salto DIGITADO ->
 *    AGRUPADA, y por eso cada corrida loguea cuanto dio de alta.
 * 2. ENTRA EN "RECIBIDO BODEGA MIAMI", NO EN "PREALERTADO". El paquete ya esta
 *    fisicamente en la bodega del proveedor; nacer prealertado seria mentir sobre
 *    donde esta.
 * 3. NO SE PREALERTA DE VUELTA. El paquete YA existe en Helga: mandarlo por la
 *    op. C lo duplicaria. El alta sella `helgaPrealertStatus = 'synced'` para que
 *    `reconcilePrealerts` no lo levante (nace 'pending' por default del insert).
 * 4. SOLO PAQUETES DE NUESTROS CLIENTES. Una fila cuyo `destinatario_id` no
 *    corresponde a ningun casillero nuestro se ignora: son destinatarios creados a
 *    mano en Helga que no nos pertenecen.
 * 5. SIN NOTIFICACION AL CLIENTE. El alta NO llama a `notificationsService`, a
 *    diferencia del avance de estado del flujo 1. El cliente no declaro este
 *    paquete y no le avisamos por un canal todavia sin validar en produccion. Es
 *    una decision de negocio revisable, no una limitacion tecnica.
 */
import type { ZodType } from 'zod';
import {
  Currency,
  HelgaSyncStatus,
  ShipmentType,
  State,
  declaredValueUsdSchema,
  formatShipmentCode,
  insuredValueUsdSchema,
  mapProviderState,
  roundMoney,
  roundWeightKg,
} from '@courier/shared';
import type { Session } from '@courier/shared';
import { isHelgaEnabled, fetchHelgaAvailablePackages } from '../../integrations/helga/helga.client';
import type { HelgaAvailablePackage } from '../../integrations/helga/helga.types';
import { clientsRepo } from '../clients/clients.repo';
import { providerSyncRepo } from './provider-sync.repo';
import { toNumber } from './provider-sync.service';
import { shipmentsRepo } from './shipments.repo';

/** Filas por pagina al recorrer la op. E. */
const DISCOVERY_PAGE_SIZE = 100;

/**
 * Estado con el que nace un paquete descubierto. Coincide con la homologacion de
 * DIGITADO, que es lo unico que la op. E devuelve hoy.
 */
const DISCOVERY_STATE = State.RecibidoBodegaMiami;

/** Descripcion de respaldo: `description` es NOT NULL y Helga puede mandar vacio. */
const FALLBACK_DESCRIPTION = 'Paquete registrado directamente en el operador de Miami.';

/** Codigo de Postgres para violacion de restriccion unica. */
const PG_UNIQUE_VIOLATION = '23505';

export interface DiscoveryReport {
  /** Filas que devolvio la op. E. */
  fetched: number;
  /** Tramites nuevos creados. */
  created: number;
  /** Filas descartadas porque su tracking ya tiene un tramite activo. */
  known: number;
  /** Filas descartadas porque el destinatario no es un casillero nuestro. */
  foreign: number;
  /** Filas descartadas por no traer tracking ni HAWB utilizable. */
  invalid: number;
  /** Filas que fallaron al insertarse. */
  failed: number;
}

/**
 * Llave con la que se cruza la fila contra `shipments.tracking`. Se prefiere el
 * tracking de tienda porque es lo que el cliente conoce y lo que usa el flujo 1;
 * el HAWB es el respaldo cuando el paquete todavia no tiene uno.
 */
function trackingKeyFor(row: HelgaAvailablePackage): string | null {
  const tracking = row.tracking?.trim();
  if (tracking) return tracking;
  const hawb = row.hawb?.trim();
  return hawb || null;
}

/** True si el error es el choque contra `shipments_active_tracking`. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Estado con el que se da de alta la fila. En la practica siempre
 * `RecibidoBodegaMiami` (la op. E solo lista DIGITADO), pero se homologa el estado
 * real en vez de asumirlo: si el proveedor amplia lo que devuelve el listado,
 * preferimos dar de alta el paquete donde de verdad esta a clavarlo en un estado
 * anterior del que `provider-sync` tendria que rescatarlo despues.
 */
function initialStateFor(row: HelgaAvailablePackage): State {
  const raw = row.estado?.trim();
  if (!raw) return DISCOVERY_STATE;
  const mapping = mapProviderState(raw);
  return mapping.kind === 'advance' ? mapping.state : DISCOVERY_STATE;
}

/**
 * Importe (USD) que reporta el proveedor, validado con el MISMO esquema que usa
 * el alta manual (`declaredValueUsdSchema` / `insuredValueUsdSchema`).
 *
 * La op. E es una fuente externa que no pasa por Zod: sin esto, un importe
 * corrupto o desproporcionado del proveedor entraria por una puerta que el
 * formulario tiene cerrada, saltandose el rango de la regla M3. Un valor que no
 * valida se descarta a `null` en vez de rechazar el paquete entero: el importe es
 * un dato accesorio y perder el paquete costaria mucho mas que perder la cifra.
 *
 * `insuredValueUsdSchema` admite 0, pero aqui 0 y `null` son equivalentes (el
 * proveedor asume 0 cuando el campo falta), asi que ambos caen a `null`.
 */
/**
 * Medida del proveedor: solo se guarda si es positiva. Su `0` significa "no
 * medido", y guardarlo se leeria despues como "mide cero", que no es lo mismo.
 */
function positiveOrNull(value: number | string | undefined): number | null {
  const n = toNumber(value);
  return n > 0 ? n : null;
}

function providerUsd(value: number | undefined, schema: ZodType<number>): number | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data <= 0) return null;
  return roundMoney(parsed.data, Currency.USD);
}

export const providerDiscoveryService = {
  /**
   * Una corrida completa: trae el listado de la op. E, descarta lo que no
   * corresponde y da de alta el resto.
   *
   * Un fallo con una fila no aborta el resto: el proveedor puede mandar una fila
   * inconsistente entre veinte sanas, y detener toda la pasada por ella dejaria
   * sin dar de alta a las demas dentro de una ventana que no se repite.
   */
  async run(session: Session): Promise<DiscoveryReport> {
    const report: DiscoveryReport = {
      fetched: 0,
      created: 0,
      known: 0,
      foreign: 0,
      invalid: 0,
      failed: 0,
    };

    if (!isHelgaEnabled()) {
      console.warn('[helga] descubrimiento omitido: la integración está apagada.');
      return report;
    }

    let rows: HelgaAvailablePackage[];
    try {
      rows = await fetchHelgaAvailablePackages({ pageSize: DISCOVERY_PAGE_SIZE });
    } catch (err) {
      // Sin listado no hay nada que descubrir. Se registra y se reintenta en la
      // proxima corrida; no tiene sentido propagar y tumbar la tarea del robot.
      console.error('[helga] fallo consultando los paquetes disponibles (op. E):', err);
      return report;
    }

    report.fetched = rows.length;
    if (rows.length === 0) return report;

    // Las filas utilizables son las que traen llave de cruce y destinatario. Se
    // resuelven en DOS consultas para todo el lote (duenos y trackings conocidos)
    // en vez de dos por fila: la op. E devuelve la cuenta consolidada entera.
    const candidates = rows
      .map((row) => ({ row, tracking: trackingKeyFor(row), helgaClientId: row.destinatario_id }))
      .filter((c) => {
        if (!c.tracking || c.helgaClientId === undefined || c.helgaClientId === null) {
          report.invalid += 1;
          return false;
        }
        return true;
      }) as Array<{ row: HelgaAvailablePackage; tracking: string; helgaClientId: number }>;

    const owners = await clientsRepo.findByHelgaClientIds([
      ...new Set(candidates.map((c) => String(c.helgaClientId))),
    ]);
    const clientByHelgaId = new Map(owners.map((o) => [o.helgaClientId, o]));
    const knownTrackings = await providerSyncRepo.activeTrackings([
      ...new Set(candidates.map((c) => c.tracking)),
    ]);

    // Helga puede repetir un tracking dentro del mismo listado; sin esto, la
    // segunda fila chocaria contra el indice unico que la primera acaba de ocupar.
    const seen = new Set<string>();

    for (const { row, tracking, helgaClientId } of candidates) {
      const owner = clientByHelgaId.get(String(helgaClientId));
      if (!owner) {
        report.foreign += 1;
        continue;
      }

      if (knownTrackings.has(tracking) || seen.has(tracking)) {
        report.known += 1;
        continue;
      }
      seen.add(tracking);

      try {
        await this.createFromProvider(session, owner.id, tracking, row);
        report.created += 1;
        console.info(`[helga] descubierto ${tracking} del casillero ${owner.code}.`);
      } catch (err) {
        // Carrera esperada: el cliente prealerto el mismo paquete mientras esta
        // corrida lo estaba insertando. No es un fallo, es el flujo 1 ganando.
        if (isUniqueViolation(err)) {
          report.known += 1;
          continue;
        }
        report.failed += 1;
        console.error(`[helga] no se pudo dar de alta ${tracking}:`, err);
      }
    }

    return report;
  },

  /**
   * Alta de un paquete descubierto.
   *
   * No pasa por `shipmentsService.insert` a proposito: ese camino impone el estado
   * inicial del flujo (`Prealertado`) y deja la bandera del proveedor en 'pending',
   * que son exactamente las dos cosas que el flujo 2 necesita distintas
   * (decisiones 2 y 3). Reusa el mismo consecutivo y el mismo repo, asi que el
   * tramite resultante es indistinguible de uno del flujo 1 salvo en eso.
   */
  async createFromProvider(
    session: Session,
    clientId: string,
    tracking: string,
    row: HelgaAvailablePackage,
  ): Promise<string> {
    const code = formatShipmentCode(await shipmentsRepo.nextCodeSequence());
    const kg = toNumber(row.peso_kg ?? row.peso);

    return shipmentsRepo.insert({
      code,
      clientId,
      shipmentType: ShipmentType.Paqueteria,
      state: initialStateFor(row),
      tracking,
      description: row.contenido?.trim() || FALLBACK_DESCRIPTION,
      store: row.tienda?.trim() || null,
      hawb: row.hawb?.trim() || null,
      weightKg: kg > 0 ? roundWeightKg(kg) : null,
      // Medidas informativas. El proveedor manda 0 cuando no midio el paquete, y
      // un 0 guardado se leeria como "mide cero" en vez de "no se sabe".
      lengthCm: positiveOrNull(row.largo),
      widthCm: positiveOrNull(row.ancho),
      heightCm: positiveOrNull(row.alto),
      volumetricWeightKg: positiveOrNull(row.volumen_peso),
      declaredValueUsd: providerUsd(row.valor_declarado, declaredValueUsdSchema),
      insuredValueUsd: providerUsd(row.valor_asegurado, insuredValueUsdSchema),
      // Decision 3: ya existe en Helga, no se vuelve a prealertar.
      helgaPrealertStatus: HelgaSyncStatus.Synced,
      // Lo dio de alta el robot, actuando como el staff de la sesion de sistema.
      createdBy: session.userId,
    });
  },
};
