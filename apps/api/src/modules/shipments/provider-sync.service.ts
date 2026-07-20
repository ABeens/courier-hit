/**
 * Sincronizacion de estados con el proveedor (docs/13).
 *
 * El proveedor reporta el tramo de USA -> Costa Rica; nosotros lo traducimos a
 * nuestros estados y avanzamos el tramite. De "En Aduanas" en adelante manda la
 * operacion manual de HS Global y esta sincronizacion ya no toca nada.
 *
 * Cuatro decisiones que viven aqui:
 *
 * 1. LA CONSULTA VA POR CASILLERO. El API de Helga esta pensada para el casillero
 *    de UN cliente ("no expone todos los paquetes del sistema"), asi que se
 *    recorre casillero por casillero y no se puede pedir "todo lo nuevo".
 * 2. SOLO SE AVANZA, NUNCA SE RETROCEDE. Se aplica `canTransition` como cualquier
 *    otro movimiento: si el proveedor reporta un estado anterior al que ya
 *    tenemos (llega tarde, o es una correccion suya), se ignora.
 * 3. NO AVANZA MAS ALLA DE "EN ADUANAS". Es el limite acordado del tramo del
 *    proveedor. Un paquete ya recibido en bodega no puede volver atras porque
 *    Helga siga moviendo su guia.
 * 4. UN ESTADO DESCONOCIDO SE REGISTRA. No se ignora en silencio: si el proveedor
 *    agrega un estado, preferimos un aviso en el log a paquetes congelados.
 *
 * TODO(13): programarla cada N minutos. Hoy se dispara a mano desde
 * `POST /shipments/sync-provider` (permiso config.manage) para poder probarla.
 */
import {
  Flow,
  ShipmentType,
  State,
  canTransition,
  flowForType,
  mapProviderState,
  roundWeightKg,
} from '@courier/shared';
import type { Session } from '@courier/shared';
import { isHelgaEnabled, fetchHelgaPackageStates } from '../../integrations/helga/helga.client';
import { notificationsService } from '../notifications/notifications.service';
import { providerSyncRepo } from './provider-sync.repo';
import { shipmentsRepo } from './shipments.repo';

/**
 * Ultimo estado que la sincronizacion puede alcanzar. Coincide con el final del
 * tramo del proveedor: mas alla empieza el flujo manual (decision 3).
 */
const PROVIDER_LAST_STATE = State.EnAduanas;

/** Estados que ya pertenecen al flujo manual: el proveedor no los toca. */
function isBeyondProvider(state: State): boolean {
  const path = [
    State.Prealertado,
    State.RecibidoBodegaMiami,
    State.PreparandoEnvio,
    State.EnTransitoCostaRica,
    State.EnAduanas,
  ];
  return !path.includes(state);
}

export interface SyncReport {
  checked: number;
  advanced: number;
  incidents: string[];
  unknownStates: string[];
}

export const providerSyncService = {
  /**
   * Recorre los casilleros enlazados con el proveedor y actualiza sus paquetes.
   *
   * Un fallo con un casillero no aborta el resto: el proveedor puede responder
   * mal para uno y bien para los demas, y detener toda la pasada por eso dejaria
   * sin actualizar a clientes que no tienen ningun problema.
   */
  async run(session: Session): Promise<SyncReport> {
    const report: SyncReport = { checked: 0, advanced: 0, incidents: [], unknownStates: [] };

    if (!isHelgaEnabled()) {
      console.warn('[helga] sincronización omitida: la integración está apagada.');
      return report;
    }

    const linked = await providerSyncRepo.linkedClients();

    for (const client of linked) {
      let packages;
      try {
        packages = await fetchHelgaPackageStates(client.helgaClientId);
      } catch (err) {
        console.error(`[helga] fallo consultando el casillero ${client.code}:`, err);
        continue;
      }

      for (const pkg of packages) {
        const tracking = (pkg.tracking ?? pkg.guia ?? '').trim().toUpperCase();
        const rawState = pkg.estado?.trim();
        if (!tracking || !rawState) continue;

        const shipment = await providerSyncRepo.findPackageByTracking(client.id, tracking);
        if (!shipment) continue;

        report.checked += 1;

        const mapping = mapProviderState(rawState);
        if (mapping.kind === 'unknown') {
          report.unknownStates.push(mapping.providerState);
          console.warn(`[helga] estado no homologado: "${mapping.providerState}" (${tracking}).`);
          continue;
        }
        if (mapping.kind === 'incident') {
          report.incidents.push(`${shipment.code}: ${mapping.providerState}`);
          continue;
        }
        if (mapping.kind === 'operational') continue;

        // El peso y el valor que reporta el proveedor son mejores que los que
        // declaro el cliente al prealertar: se refrescan aunque el estado no
        // avance, porque de ellos depende el flete.
        const weight = pkg.peso ?? pkg.peso_lb;
        if (weight && weight > 0 && shipment.weightKg !== roundWeightKg(weight)) {
          await shipmentsRepo.update(shipment.id, { weightKg: roundWeightKg(weight) });
        }

        if (isBeyondProvider(shipment.state)) continue;
        if (mapping.state === shipment.state) continue;

        const flow = flowForType(shipment.shipmentType);
        const advanced = await this.advanceTowards(session, shipment, flow, mapping.state);
        report.advanced += advanced;
      }
    }

    return report;
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
