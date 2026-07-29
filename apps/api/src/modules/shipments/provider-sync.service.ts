/**
 * Sincronizacion de estados con el proveedor (docs/13).
 *
 * El proveedor reporta el tramo de USA -> Costa Rica; nosotros lo traducimos a
 * nuestros estados y avanzamos el tramite. De "En Aduanas" en adelante manda la
 * operacion manual de HS Global y esta sincronizacion ya no toca nada.
 *
 * Cuatro decisiones que viven aqui:
 *
 * 1. LA CONSULTA VA POR TRACKING. La op. B de Helga busca UN paquete por su
 *    HAWB/tracking, no lista los de un casillero. Asi que la sincronizacion parte
 *    de NUESTROS envios en tramo y le pregunta a Helga por cada tracking. Un 404
 *    significa que el paquete aun no llega a bodega (prealerta): no es error.
 * 2. SOLO SE AVANZA, NUNCA SE RETROCEDE. Se aplica `canTransition` como cualquier
 *    otro movimiento: si el proveedor reporta un estado anterior al que ya
 *    tenemos (llega tarde, o es una correccion suya), se ignora.
 * 3. NO AVANZA MAS ALLA DE "EN ADUANAS". Es el limite acordado del tramo del
 *    proveedor. Un paquete ya recibido en bodega no puede volver atras porque
 *    Helga siga moviendo su guia.
 * 4. UN ESTADO DESCONOCIDO SE REGISTRA. No se ignora en silencio: si el proveedor
 *    agrega un estado, preferimos un aviso en el log a paquetes congelados.
 *
 * Se agenda en el scheduler (`core/scheduler/jobs.ts`) cada `ROBOT_PROVIDER_SYNC_EVERY`;
 * tambien se puede disparar a mano desde `POST /shipments/sync-provider`.
 */
import {
  Flow,
  ShipmentType,
  State,
  canTransition,
  flowForType,
  isProviderDrivenState,
  mapProviderState,
  roundWeightKg,
} from '@courier/shared';
import type { Session } from '@courier/shared';
import type { HelgaPackageStatus } from '../../integrations/helga/helga.types';
import { isHelgaEnabled, fetchHelgaPackageState } from '../../integrations/helga/helga.client';
import { notificationsService } from '../notifications/notifications.service';
import { providerSyncRepo } from './provider-sync.repo';
import { shipmentsRepo } from './shipments.repo';

/**
 * Ultimo estado que la sincronizacion puede alcanzar. Coincide con el final del
 * tramo del proveedor: mas alla empieza el flujo manual (decision 3).
 */
const PROVIDER_LAST_STATE = State.EnAduanas;

/** Techo de envios a consultar por corrida (una llamada a Helga por cada uno). */
const SYNC_BATCH = 200;

/**
 * Helga a veces reporta el peso como cadena ("1.38"); lo normaliza a numero.
 * Exportado porque el descubrimiento (flujo 2) lee los mismos campos del mismo
 * proveedor: dos copias de esta normalizacion podrian divergir.
 */
export function toNumber(value: number | string | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Estados que ya pertenecen al flujo manual: el proveedor no los toca.
 *
 * La frontera sale de `isProviderDrivenState` (shared) para no tener dos copias
 * de la misma linea: la web decide con ella que avances manuales ofrecer, y si
 * aqui se listara aparte, una tarea podria avanzar lo que alla se ofrece a mano.
 * Prealertado se suma porque es el punto de partida, todavia dentro del tramo.
 */
function isBeyondProvider(state: State): boolean {
  return state !== State.Prealertado && !isProviderDrivenState(Flow.Paqueteria, state);
}

export interface SyncReport {
  checked: number;
  advanced: number;
  incidents: string[];
  unknownStates: string[];
  /** Paquetes cuyo casillero no coincide con el del tramite (ver `checkLockerMatch`). */
  lockerMismatches: string[];
}

export const providerSyncService = {
  /**
   * Recorre nuestros envios en el tramo del proveedor y le pregunta a Helga por
   * cada tracking (op. B).
   *
   * Un fallo con un envio no aborta el resto: el proveedor puede responder mal
   * para uno y bien para los demas, y detener toda la pasada por eso dejaria sin
   * actualizar a los que no tienen ningun problema.
   */
  async run(session: Session): Promise<SyncReport> {
    const report: SyncReport = {
      checked: 0,
      advanced: 0,
      incidents: [],
      unknownStates: [],
      lockerMismatches: [],
    };

    if (!isHelgaEnabled()) {
      console.warn('[helga] sincronización omitida: la integración está apagada.');
      return report;
    }

    const pending = await providerSyncRepo.shipmentsInProviderTramo(SYNC_BATCH);

    for (const shipment of pending) {
      let pkg;
      try {
        pkg = await fetchHelgaPackageState(shipment.tracking);
      } catch (err) {
        console.error(`[helga] fallo consultando ${shipment.code} (${shipment.tracking}):`, err);
        continue;
      }

      // 404: el paquete aun no existe del lado de Helga (prealerta sin llegar).
      if (!pkg) continue;

      const rawState = pkg.Estado_Envio?.trim();
      // "NO TIENE ESTADO": el paquete existe pero aun no tiene tracking util; no
      // hay nada que homologar todavia.
      if (!rawState || rawState.toUpperCase() === 'NO TIENE ESTADO') continue;

      report.checked += 1;

      const mapping = mapProviderState(rawState);
      if (mapping.kind === 'unknown') {
        report.unknownStates.push(mapping.providerState);
        console.warn(`[helga] estado no homologado: "${mapping.providerState}" (${shipment.tracking}).`);
        continue;
      }
      if (mapping.kind === 'incident') {
        report.incidents.push(`${shipment.code}: ${mapping.providerState}`);
        continue;
      }
      if (mapping.kind === 'operational') continue;

      // Control de identidad: el proveedor dice de QUE casillero es el paquete.
      // Si no coincide con el nuestro, el tracking apunta a un paquete ajeno y
      // avanzarlo movería el trámite equivocado.
      this.checkLockerMatch(shipment, pkg, report);

      // El peso que reporta el proveedor (kg explicito) es mejor que el que
      // declaro el cliente al prealertar: se refresca aunque el estado no avance,
      // porque de el depende el flete. Las medidas viajan en la misma escritura:
      // son informativas, pero pedirlas de nuevo mas tarde es imposible (la op. B
      // solo responde mientras el paquete esta en el tramo del proveedor).
      const patch = this.measurementsPatch(shipment, pkg);
      if (Object.keys(patch).length > 0) {
        await shipmentsRepo.update(shipment.id, patch);
      }

      if (isBeyondProvider(shipment.state)) continue;
      if (mapping.state === shipment.state) continue;

      const flow = flowForType(shipment.shipmentType);
      const advanced = await this.advanceTowards(session, shipment, flow, mapping.state);
      report.advanced += advanced;
    }

    return report;
  },

  /**
   * Avisa si el paquete que devolvio el proveedor NO es del casillero que
   * esperabamos.
   *
   * `datos.cliente[].codigo_casillero` es el sub-casillero del dueño segun Helga.
   * Comparado con el nuestro detecta el caso peligroso: un tracking mal digitado,
   * o reciclado por el transportista, que apunta al paquete de otra persona. Sin
   * este control la sincronizacion avanzaria el tramite equivocado y el cliente
   * veria moverse un paquete que no es suyo.
   *
   * SOLO AVISA, no bloquea. Hoy no hay certeza de que el proveedor llene siempre
   * ese campo (`cliente` puede venir vacio) ni de que el sub-casillero de un
   * paquete recibido antes del enlace coincida; convertirlo en bloqueo dejaria
   * paquetes legitimos congelados. Cuando el log confirme que no hay falsos
   * positivos, esto puede pasar a frenar el avance.
   */
  checkLockerMatch(
    shipment: { code: string; tracking: string; clientSubLocker: string | null },
    pkg: { cliente?: Array<{ codigo_casillero?: string }> },
    report: SyncReport,
  ): void {
    const expected = shipment.clientSubLocker?.trim().toUpperCase();
    if (!expected) return; // casillero aun sin enlazar: no hay contra que comparar

    const reported = pkg.cliente
      ?.map((c) => c.codigo_casillero?.trim().toUpperCase())
      .filter((c): c is string => Boolean(c));
    if (!reported?.length) return; // el proveedor no lo informo

    if (reported.includes(expected)) return;

    const detail = `${shipment.code} (${shipment.tracking}): esperado ${expected}, reportado ${reported.join(', ')}`;
    report.lockerMismatches.push(detail);
    console.warn(`[helga] el paquete no coincide con el casillero del trámite -> ${detail}`);
  },

  /**
   * Campos de medida a actualizar. Devuelve solo lo que CAMBIA: una escritura por
   * paquete y por corrida, cuando de verdad hay algo nuevo, en vez de una por
   * campo o una siempre.
   */
  measurementsPatch(
    shipment: { weightKg: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null; volumetricWeightKg: number | null },
    pkg: HelgaPackageStatus,
  ): Record<string, number> {
    const patch: Record<string, number> = {};

    const kg = toNumber(pkg.Peso_kg);
    if (kg > 0 && shipment.weightKg !== roundWeightKg(kg)) patch.weightKg = roundWeightKg(kg);

    // Las dimensiones NO se redondean: son informativas y el redondeo hacia arriba
    // del peso existe por una regla de facturacion que aqui no aplica.
    const dims = [
      ['lengthCm', toNumber(pkg.Largo_cm), shipment.lengthCm],
      ['widthCm', toNumber(pkg.Ancho_cm), shipment.widthCm],
      ['heightCm', toNumber(pkg.Alto_cm), shipment.heightCm],
      ['volumetricWeightKg', toNumber(pkg.Peso_volumen), shipment.volumetricWeightKg],
    ] as const;
    for (const [field, value, current] of dims) {
      // El proveedor manda 0 cuando no midio el paquete: no es una medida.
      if (value > 0 && current !== value) patch[field] = value;
    }

    return patch;
  },

  /**
   * Lleva el tramite hasta `target` recorriendo la ruta principal paso a paso.
   *
   * El proveedor puede saltarse tramos (su primer reporte a veces ya viene "EN
   * PLANILLA DE ENTREGA"), pero nuestra maquina exige secuencia estricta. Avanzar
   * de uno en uno respeta esa regla y deja en el historial los estados
   * intermedios, que es lo que el cliente ve como seguimiento.
   */
  async advanceTowards(
    session: Session,
    shipment: { id: string; state: State; shipmentType: ShipmentType; tracking: string; description: string },
    flow: Flow,
    target: State,
  ): Promise<number> {
    if (flow !== Flow.Paqueteria) return 0;

    const path = [
      State.Prealertado,
      State.RecibidoBodegaMiami,
      State.PreparandoEnvio,
      State.EnTransitoCostaRica,
      PROVIDER_LAST_STATE,
    ];

    const from = path.indexOf(shipment.state);
    const to = path.indexOf(target);
    // Estado anterior o fuera del tramo del proveedor: no se retrocede (decision 2).
    if (from < 0 || to <= from) return 0;

    let current = shipment.state;
    let moved = 0;

    for (const next of path.slice(from + 1, to + 1)) {
      if (!canTransition(flow, current, next)) break;
      await shipmentsRepo.transition(
        shipment.id,
        next,
        session.userId,
        'Actualizado desde el operador en Miami.',
      );
      await notificationsService.onStateChange(shipment, next);
      current = next;
      moved += 1;
    }

    return moved;
  },
};
