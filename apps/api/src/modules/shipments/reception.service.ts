/**
 * Recepcion de paquetes en la bodega de HS Global (Parte 4, "Recepción de
 * Paquete"): el operador escanea o digita un HAWB (LES) y el sistema decide.
 *
 * El identificador que entra es el LES, NO el tracking de la tienda: es el que
 * la bodega de Miami imprime en la etiqueta del bulto y el que la pistola lee en
 * la mesa. El tracking sigue siendo la llave contra el proveedor, pero no es lo
 * que hay pegado en la caja.
 *
 * Dos desenlaces, los dos del manual:
 *   - EL TRAMITE EXISTE -> se mueve a "Facturación en proceso", que es el punto
 *     donde arranca la carga de costos.
 *   - NO EXISTE -> se responde con un codigo estable para que la web abra el alta
 *     manual. No es un error de la operacion: es una rama prevista del flujo.
 *
 * El avance en si no se hace aqui: se delega en `transitionsService`, que es el
 * punto unico de cambio de estado. Este servicio solo resuelve el LES.
 */
import { STATE_LABELS, State } from '@courier/shared';
import type { ReceiveShipmentInput, Session } from '@courier/shared';
import { ReceptionErrors } from '../../core/errors';
import { shipmentsRepo } from './shipments.repo';
import { transitionsService } from './transitions.service';

export const receptionService = {
  /**
   * Registra la llegada de un paquete a bodega. Busca por el HAWB (LES) entre los
   * tramites ACTIVOS: un LES reciclado de un envio ya entregado no debe reabrir
   * aquel tramite. Si hay mas de uno activo con ese LES no se elige por cuenta
   * propia, porque recibir el equivocado le cambia el estado a otro cliente.
   */
  async receive(session: Session, input: ReceiveShipmentInput) {
    const [match, duplicate] = await shipmentsRepo.findActiveByHawb(input.hawb);
    if (!match) throw ReceptionErrors.unknownHawb(input.hawb);
    if (duplicate) throw ReceptionErrors.ambiguousHawb(input.hawb);

    const row = await shipmentsRepo.findById(match.id);
    if (!row) throw ReceptionErrors.unknownHawb(input.hawb);

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
