/**
 * Reglas de negocio de las entregas (Parte 5, rol Mensajeria).
 *
 * Tres decisiones que viven aqui y en ningun otro lado:
 *
 * 1. EL INTENTO Y EL ESTADO VAN JUNTOS. Registrar la visita y mover el tramite
 *    son un solo acto: un intento sin avance dejaria al paquete "en ruta" para
 *    siempre, y un avance sin intento perderia la prueba de la entrega.
 * 2. LA PRUEBA ES OBLIGATORIA Y SU REGLA VIVE EN SHARED. `proofRequirementFor`
 *    dice que exige cada desenlace; aqui solo se comprueba. Asi la web habilita
 *    el boton con el mismo criterio con el que la API acepta.
 * 3. EL AVANCE SALTA EL PERMISO DEL ESTADO DESTINO. Confirmar la entrega ES la
 *    autorizacion: al mensajero ya se le exigio delivery.manage para llegar aqui.
 *    Las guardas de DATOS de la maquina se aplican igual.
 */
import { DeliveryOutcome, State, proofRequirementFor, stateForOutcome } from '@courier/shared';
import type {
  DeliveryAttemptDto,
  ListDeliveryQueueQuery,
  RecordDeliveryAttemptInput,
  Session,
} from '@courier/shared';
import { DeliveryErrors, ShipmentErrors } from '../../core/errors';
import { storage } from '../../core/storage';
import { shipmentsRepo } from '../shipments/shipments.repo';
import { transitionsService } from '../shipments/transitions.service';
import { deliveriesRepo } from './deliveries.repo';

/** Fila de BD -> DTO de la API (fechas en ISO/UTC). */
function toDto(row: Awaited<ReturnType<typeof deliveriesRepo.listByShipment>>[number]): DeliveryAttemptDto {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    outcome: row.outcome,
    photoFileKey: row.photoFileKey,
    note: row.note,
    courierName: row.courierName,
    createdAt: row.createdAt.toISOString(),
  };
}

export const deliveriesService = {
  /** Cola del dia: lo que el mensajero tiene que repartir. */
  async queue(query: ListDeliveryQueueQuery) {
    const rows = await deliveriesRepo.queue(query);
    return {
      items: rows.map((row) => ({
        ...row,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  },

  /** Historial de intentos de un tramite. */
  async listByShipment(shipmentId: string): Promise<{ items: DeliveryAttemptDto[] }> {
    const rows = await deliveriesRepo.listByShipment(shipmentId);
    return { items: rows.map(toDto) };
  },

  /**
   * Registra el desenlace de una visita y mueve el tramite en consecuencia.
   *
   * El orden importa: primero se guarda el archivo, luego se escribe el intento y
   * al final se avanza el estado. Si el avance falla (una guarda de la maquina no
   * se cumple) queda el intento con su prueba y el tramite sin mover, que es el
   * estado del que un operador puede salir. Al reves habriamos avanzado un
   * tramite del que no queda constancia de por que.
   */
  async record(
    session: Session,
    shipmentId: string,
    input: RecordDeliveryAttemptInput,
    photo: File | null,
  ) {
    const shipment = await shipmentsRepo.findById(shipmentId);
    if (!shipment) throw ShipmentErrors.notFound();

    // La cola del mensajero son los tramites en ruta; registrar una visita sobre
    // cualquier otro es un error de la UI, no un caso de negocio.
    if (shipment.state !== State.EnRutaEntrega) throw DeliveryErrors.notInRoute();

    const required = proofRequirementFor(input.outcome);
    if (required.photo && !photo) throw DeliveryErrors.photoRequired();

    const photoFileKey = photo ? await storage.put('deliveries', photo) : null;

    await deliveriesRepo.insert({
      shipmentId,
      outcome: input.outcome,
      photoFileKey,
      note: input.note ?? null,
      courierId: session.userId,
    });

    /**
     * La nota del evento: en una devolucion es la razon que dio el mensajero
     * (Condition.RequiresComment la exige); en una entrega, una linea fija que
     * deja claro en el historial de donde salio el avance.
     */
    const note =
      input.outcome === DeliveryOutcome.DevueltoBodega
        ? input.note
        : 'Entrega confirmada con foto.';

    return transitionsService.transition(
      session,
      shipmentId,
      { state: stateForOutcome(input.outcome), note },
      { skipPermission: true },
    );
  },

  /** Foto de un intento. */
  async photoFile(attemptId: string) {
    const attempt = await deliveriesRepo.findById(attemptId);
    if (!attempt?.photoFileKey) throw DeliveryErrors.photoRequired();
    return storage.get(attempt.photoFileKey);
  },
};
