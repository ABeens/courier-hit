/**
 * Cambio de estado de un tramite: la pieza de la que cuelgan la recepcion en
 * bodega, el modulo de entregas y el avance manual del panel.
 *
 * Vive aparte de `shipments.service` porque su responsabilidad es distinta: aquel
 * gestiona los DATOS del tramite, este su AVANCE. Y porque lo llaman varios
 * modulos: si cada uno moviera el estado por su cuenta, las guardas de la maquina
 * se aplicarian en unos sitios y en otros no.
 *
 * Cuatro barreras, en este orden. Ninguna se puede saltar:
 *
 * 1. LEGALIDAD    — `canTransition`: el destino sale del estado actual en ese flow.
 * 2. PERMISO      — `permissionFor`: el rol puede llevar el tramite a ese estado.
 * 3. CONDICIONES  — las guardas de datos del step destino (comentario, monto de
 *                   factura, pago confirmado).
 * 4. EFECTOS      — se escribe el evento y se disparan los triggers (correo).
 *
 * Las tres primeras salen de @courier/shared. Aqui no se decide ninguna regla: se
 * traduce cada guarda a la consulta que la responde.
 */
import {
  Condition,
  STATE_LABELS,
  can,
  canTransition,
  conditionsFor,
  flowForType,
  isSettled,
  permissionFor,
} from '@courier/shared';
import type { Session, State, TransitionShipmentInput } from '@courier/shared';
import { AuthErrors, ShipmentErrors, TransitionErrors } from '../../core/errors';
import { notificationsService } from '../notifications/notifications.service';
import { paymentsRepo } from '../payments/payments.repo';
import { shipmentsRepo } from './shipments.repo';

/** Fila del tramite tal como la devuelve el repo. */
type ShipmentRow = NonNullable<Awaited<ReturnType<typeof shipmentsRepo.findById>>>;

/**
 * Comprueba las guardas de datos del estado destino. Cada Condition se traduce a
 * la pregunta que la responde; una Condition sin traducir aqui es un olvido, no
 * un permiso, asi que el `switch` es exhaustivo a proposito.
 */
async function assertConditions(
  row: ShipmentRow,
  to: State,
  note: string | undefined,
): Promise<void> {
  for (const condition of conditionsFor(flowForType(row.shipmentType), to)) {
    switch (condition) {
      case Condition.RequiresComment:
        if (!note?.trim()) throw TransitionErrors.requiresComment();
        break;

      case Condition.RequiresInvoiceAmount:
        if (row.invoiceTotalCrc == null) throw TransitionErrors.requiresInvoiceAmount();
        break;

      case Condition.RequiresConfirmedPayment: {
        const paid = await paymentsRepo.settlementView(row.id);
        if (!isSettled(paid, row.invoiceTotalCrc)) {
          throw TransitionErrors.requiresConfirmedPayment();
        }
        break;
      }
    }
  }
}

export const transitionsService = {
  /**
   * Mueve el tramite a `state`. Punto UNICO de cambio de estado del sistema:
   * cualquier modulo que necesite avanzar un tramite pasa por aqui.
   *
   * `skipPermission` existe para los avances que son CONSECUENCIA de un acto ya
   * autorizado —confirmar una entrega, aprobar unos costos— donde volver a exigir
   * el permiso del estado destino pediria dos veces lo mismo. Las guardas de
   * datos (paso 3) se aplican igual: esas nunca se saltan.
   */
  async transition(
    session: Session,
    id: string,
    input: TransitionShipmentInput,
    options: { skipPermission?: boolean } = {},
  ) {
    const row = await shipmentsRepo.findById(id);
    if (!row) throw ShipmentErrors.notFound();

    const flow = flowForType(row.shipmentType);
    const to = input.state;

    // 1. Legalidad del movimiento en la maquina de estados.
    if (!canTransition(flow, row.state, to)) {
      throw TransitionErrors.notAllowed(STATE_LABELS[row.state], STATE_LABELS[to]);
    }

    // 2. Permiso del rol para llevar el tramite a ese estado.
    if (!options.skipPermission) {
      const permission = permissionFor(flow, to);
      if (!permission || !can(session.role, permission)) throw AuthErrors.forbidden();
    }

    // 3. Guardas de datos del step destino.
    await assertConditions(row, to, input.note);

    // 4. Efectos: el evento y las automatizaciones del estado.
    await shipmentsRepo.transition(id, to, session.userId, input.note);
    await notificationsService.onStateChange(row, to);

    const updated = await shipmentsRepo.findById(id);
    if (!updated) throw ShipmentErrors.notFound();
    return updated;
  },
};
