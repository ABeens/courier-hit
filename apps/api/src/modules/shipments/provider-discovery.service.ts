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
 * `core/scheduler/jobs.ts` cada `ROBOT_PACKAGE_DISCOVERY_EVERY`.
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
 *    mano en Helga que no nos pertenecen. OJO: esto vale para la cuenta PRINCIPAL.
 *    En una cuenta EXCLUSIVA no se cruza nada, porque toda la cuenta es de un solo
 *    cliente (ver `ownerFor`).
 * 5. UNA PASADA POR CUENTA. La op. E lista los paquetes de LA CUENTA con cuyo
 *    token se pregunta, y cada cuenta de Helga solo ve los suyos. Asi que el
 *    recorrido va cuenta por cuenta: la principal (que reparte entre muchos
 *    clientes por `destinatario_id`) y despues cada cuenta exclusiva, cuyo listado
 *    entero se le atribuye a su cliente consolidado. Un fallo con una cuenta no
 *    detiene a las siguientes; queda sellado en la fila de esa cuenta.
 * 6. SIN NOTIFICACION AL CLIENTE. El alta NO llama a `notificationsService`, a
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
} from '@courier/shared';
import type { Session } from '@courier/shared';
import {
  isHelgaEnabled,
  isHelgaSimulated,
  fetchHelgaAvailablePackages,
} from '../../integrations/helga/helga.client';
import type { HelgaAvailablePackage } from '../../integrations/helga/helga.types';
import type { HelgaAccount } from '../../core/config';
import { clientsRepo } from '../clients/clients.repo';
import { providerAccountsRepo } from '../provider-accounts/provider-accounts.repo';
import { providerAccountsService } from '../provider-accounts/provider-accounts.service';
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
  /** Cuentas del proveedor recorridas en la corrida. */
  accounts: number;
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

/**
 * Una cuenta del proveedor a la que hay que preguntarle su listado.
 *
 * `account` ausente significa "el transporte decide": es el caso del proveedor
 * SIMULADO, que no pide credenciales, y el de un despliegue que solo tiene la
 * cuenta principal del entorno.
 */
interface DiscoveryTarget {
  /** Fila en `provider_accounts`, o `null` si es la principal (vive en el .env). */
  id: string | null;
  /** Codigo que se sella como origen en cada paquete; `null` = sin identificar. */
  code: string | null;
  account: HelgaAccount | null;
  /**
   * Dueno de TODO lo que traiga la cuenta. `null` en la principal, donde el dueno
   * se resuelve paquete a paquete por su `destinatario_id`.
   */
  consolidatedClientId: string | null;
}

export const providerDiscoveryService = {
  /**
   * Una corrida completa: recorre las cuentas del proveedor y, en cada una, trae
   * el listado de la op. E, descarta lo que no corresponde y da de alta el resto.
   *
   * El informe que devuelve es la SUMA de todas las cuentas: al robot le interesa
   * cuanto entro en la corrida, y el detalle por cuenta ya va al log (y el fallo,
   * a la propia fila de la cuenta).
   */
  async run(session: Session): Promise<DiscoveryReport> {
    const report: DiscoveryReport = {
      fetched: 0,
      created: 0,
      known: 0,
      foreign: 0,
      invalid: 0,
      failed: 0,
      accounts: 0,
    };

    if (!isHelgaEnabled()) {
      console.warn('[helga] descubrimiento omitido: la integración está apagada.');
      return report;
    }

    for (const target of await this.targets()) {
      report.accounts += 1;
      const one = await this.runAccount(session, target);
      report.fetched += one.fetched;
      report.created += one.created;
      report.known += one.known;
      report.foreign += one.foreign;
      report.invalid += one.invalid;
      report.failed += one.failed;
    }

    return report;
  },

  /**
   * Las cuentas de esta corrida.
   *
   * Con el proveedor SIMULADO se hace UNA sola pasada y sin credenciales: el
   * simulador es un unico proveedor de mentira que responde lo mismo a cualquier
   * cuenta, asi que recorrerlas todas seria pedir el mismo listado N veces (y
   * atribuirselo a quien saliera primero).
   */
  async targets(): Promise<DiscoveryTarget[]> {
    if (isHelgaSimulated()) {
      return [{ id: null, code: null, account: null, consolidatedClientId: null }];
    }
    const accounts = await providerAccountsService.accountsForImport();
    return accounts.map((a) => ({
      id: a.id,
      code: a.account.code,
      account: a.account,
      consolidatedClientId: a.consolidatedClientId,
    }));
  },

  /**
   * El listado de UNA cuenta, dado de alta.
   *
   * Un fallo con una fila no aborta el resto: el proveedor puede mandar una fila
   * inconsistente entre veinte sanas, y detener toda la pasada por ella dejaria
   * sin dar de alta a las demas dentro de una ventana que no se repite.
   *
   * Un fallo con la CUENTA entera (credenciales caducadas, lista blanca) tampoco
   * aborta la corrida: se sella en la fila de esa cuenta, que es lo que el panel
   * muestra como motivo de que no le lleguen paquetes, y se sigue con la
   * siguiente.
   */
  async runAccount(session: Session, target: DiscoveryTarget): Promise<DiscoveryReport> {
    const report: DiscoveryReport = {
      fetched: 0,
      created: 0,
      known: 0,
      foreign: 0,
      invalid: 0,
      failed: 0,
      accounts: 1,
    };
    const label = target.code ?? 'cuenta principal';

    let rows: HelgaAvailablePackage[];
    try {
      rows = await fetchHelgaAvailablePackages({
        pageSize: DISCOVERY_PAGE_SIZE,
        ...(target.account ? { account: target.account } : {}),
      });
    } catch (err) {
      // Sin listado no hay nada que descubrir. Se registra y se reintenta en la
      // proxima corrida; no tiene sentido propagar y tumbar la tarea del robot.
      console.error(`[helga] fallo consultando los paquetes disponibles (op. E) de ${label}:`, err);
      await this.markImport(target, err instanceof Error ? err.message : String(err));
      return report;
    }

    report.fetched = rows.length;
    if (rows.length === 0) {
      await this.markImport(target, null);
      return report;
    }

    // Las filas utilizables son las que traen llave de cruce. El destinatario solo
    // hace falta en la cuenta principal, que es donde decide de quien es el
    // paquete; en una cuenta exclusiva ya se sabe, y exigirlo tiraria filas que
    // el proveedor mando sin ese campo.
    const needsRecipient = target.consolidatedClientId === null;
    const candidates = rows
      .map((row) => ({ row, tracking: trackingKeyFor(row), helgaClientId: row.destinatario_id }))
      .filter((c) => {
        const missingRecipient =
          needsRecipient && (c.helgaClientId === undefined || c.helgaClientId === null);
        if (!c.tracking || missingRecipient) {
          report.invalid += 1;
          return false;
        }
        return true;
      }) as Array<{
        row: HelgaAvailablePackage;
        tracking: string;
        helgaClientId: number | undefined;
      }>;

    /**
     * Indice destinatario -> casillero nuestro. Solo se construye para la cuenta
     * principal: es la unica que reparte sus paquetes entre varios clientes. En
     * una cuenta exclusiva esta consulta seria trabajo tirado, porque el dueno es
     * el mismo para todas las filas.
     */
    const owners = needsRecipient
      ? await clientsRepo.findByHelgaClientIds([
          ...new Set(
            candidates
              .map((c) => c.helgaClientId)
              .filter((id): id is number => id !== undefined && id !== null)
              .map(String),
          ),
        ])
      : [];
    const clientByHelgaId = new Map(owners.map((o) => [o.helgaClientId, o]));

    const knownTrackings = await providerSyncRepo.activeTrackings([
      ...new Set(candidates.map((c) => c.tracking)),
    ]);

    // Helga puede repetir un tracking dentro del mismo listado; sin esto, la
    // segunda fila chocaria contra el indice unico que la primera acaba de ocupar.
    const seen = new Set<string>();

    for (const { row, tracking, helgaClientId } of candidates) {
      /**
       * DE QUIEN ES EL PAQUETE. Es la unica diferencia real entre los dos tipos de
       * cuenta: la principal lo decide fila a fila por el destinatario, y una
       * cuenta exclusiva no lo decide, ya lo sabe (relacion 1 a 1 con su cliente
       * consolidado, vengan sus paquetes de uno o de veinte sub-casilleros).
       */
      const owner = target.consolidatedClientId
        ? { id: target.consolidatedClientId, code: target.code ?? '' }
        : clientByHelgaId.get(String(helgaClientId));
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
        await this.createFromProvider(session, owner.id, tracking, row, target.code);
        report.created += 1;
        console.info(`[helga] descubierto ${tracking} del casillero ${owner.code} (${label}).`);
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

    await this.markImport(target, null);
    return report;
  },

  /**
   * Sella el resultado de la pasada en la fila de la cuenta. La principal no tiene
   * fila (vive en el entorno), asi que ahi no hay nada que sellar.
   */
  async markImport(target: DiscoveryTarget, error: string | null): Promise<void> {
    if (!target.id) return;
    try {
      await providerAccountsRepo.markImport(target.id, error);
    } catch (err) {
      // El sello es diagnostico: perderlo no puede costar la corrida.
      console.error(`[helga] no se pudo sellar la importación de ${target.code}:`, err);
    }
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
    providerAccountCode: string | null = null,
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
      // Peso de bascula del proveedor, tal cual: el redondeo de cobro se aplica
      // al cotizar el flete, no al guardar (`billableWeightKg`).
      weightKg: kg > 0 ? kg : null,
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
      /**
       * De que cuenta vino. No es solo trazabilidad: es lo que le dice a la
       * sincronizacion con que token preguntar por este tracking despues (ver
       * `shipments.schema`). `null` = la principal.
       */
      providerAccountCode,
      // Lo dio de alta el robot, actuando como el staff de la sesion de sistema.
      createdBy: session.userId,
    });
  },
};
