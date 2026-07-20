/**
 * Recepcion de paquetes en la bodega de HS Global (Parte 4, "Recepción de
 * Paquete"): el operador escanea o digita un tracking y el sistema decide.
 *
 * Dos desenlaces, los dos del manual:
 *   - EL TRAMITE EXISTE -> se mueve a "Facturación en proceso", que es el punto
 *     donde arranca la carga de costos.
 *   - NO EXISTE -> se responde con un codigo estable para que la web abra el alta
 *     manual. No es un error de la operacion: es una rama prevista del flujo.
 *
 * El avance en si no se hace aqui: se delega en `transitionsService`, que es el
 * punto unico de cambio de estado. Este servicio solo resuelve el tracking.
 */
import { STATE_LABELS, State } from '@courier/shared';
import type { ReceiveShipmentInput, Session } from '@courier/shared';
import { ReceptionErrors } from '../../core/errors';
import { shipmentsRepo } from './shipments.repo';
import { transitionsService } from './transitions.service';

export const receptionService = {
  /**
   * Registra la llegada de un paquete a bodega. Busca por el tracking ACTIVO
   * (mismo criterio que el indice unico parcial): un tracking reciclado de un
   * envio ya entregado no debe reabrir aquel tramite.
   */
  async receive(session: Session, input: ReceiveShipmentInput) {
    const match = await shipmentsRepo.findActiveByTracking(input.tracking);
    if (!match) throw ReceptionErrors.unknownTracking(input.tracking);

    const row = await shipmentsRepo.findById(match.id);
    if (!row) throw ReceptionErrors.unknownTracking(input.tracking);

    // Escanear dos veces el mismo bulto es normal en una mesa de bodega: se
    // responde con un mensaje claro en vez de con un error de transicion críptico.
    if (row.state === State.FacturacionEnProceso) {
      throw ReceptionErrors.alreadyReceived(STATE_LABELS[row.state]);
    }

    return transitionsService.transition(session, row.id, {
      state: State.FacturacionEnProceso,
      note: 'Recibido en bodega HS Global.',
    });
  },
};
