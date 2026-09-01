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
 *
 * Sobre las cuatro va un paso 5, que no es una barrera sino un ENCADENAMIENTO: al
 * entrar a "Facturación en proceso" con una tarifa que no ocupa revisión, el
 * tramite se factura solo y sigue hasta cobro (OPS-003, ver `autoBillingService`).
 */
import {
  Condition,
  STATE_LABELS,
  State,
  can,
  canTransition,
  conditionsFor,
  flowForType,
  chargeBasisFor,
  isSettled,
  permissionFor,
  statesOf,
} from '@courier/shared';
import type { CorrectStateInput, Session, TransitionShipmentInput } from '@courier/shared';
import { AuthErrors, ShipmentErrors, TransitionErrors } from '../../core/errors';
import { autoBillingService } from '../costs/auto-billing.service';
import { notificationsService } from '../notifications/notifications.service';
import { paymentsRepo } from '../payments/payments.repo';
import { shipmentsRepo } from './shipments.repo';

/** Fila del tramite tal como la devuelve el repo. */
type ShipmentRow = NonNullable<Awaited<ReturnType<typeof shipmentsRepo.findById>>>;

/**
 * Barrera 0: el tramite tiene que ser operable. La comparten el avance y la
 * correccion, que es lo que la hace util: son las DOS puertas por las que un
 * tramite se mueve, y las dos deben negarse por lo mismo.
 *
 * - SIN DUEÑO: un paquete que llego a bodega sin identificar no puede avanzar.
 *   Todo lo que viene despues de "Facturación en proceso" pregunta por el
 *   casillero —la tarifa para cotizar, la cuenta para cobrar, la direccion para
 *   entregar—, asi que dejarlo avanzar lo llevaria a un estado desde el que
 *   ninguna de esas tres cosas se puede hacer. Se queda quieto hasta que la sala
 *   de control le ponga dueño.
 * - DESCARTADO: esta archivado. Primero se restaura, despues se opera.
 */
function assertOperable(row: ShipmentRow): void {
  if (row.discardedAt !== null) throw ShipmentErrors.discarded();
  if (row.clientId === null) throw ShipmentErrors.unassigned();
}

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
        // En la moneda con la que se le cobro (`chargeCurrencyFor`). Preguntarlo
        // en la otra columna retiene un paquete de Paqueteria que ya pago sus
        // dolares, por los colones que la conversion deja sueltos.
        if (!isSettled(paid, chargeBasisFor(row.shipmentType, row))) {
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
  ): Promise<ShipmentRow> {
    const row = await shipmentsRepo.findById(id);
    if (!row) throw ShipmentErrors.notFound();
    assertOperable(row);

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

    /**
     * 5. FACTURACION AUTOMATICA (OPS-003). Entrar a "Facturacion en proceso" con
     * una tarifa que NO ocupa revision no deja el paquete esperando a nadie: el
     * sistema le cotiza el flete, congela la factura y lo sigue hasta cobro.
     *
     * Cuelga de aqui y no de la recepcion porque este es el punto UNICO de cambio
     * de estado: da igual si el paquete entro a facturacion por el escaner de
     * bodega o por el avance manual del panel, la tarifa manda igual.
     *
     * El segundo tramo se hace con `transition` (no tocando el repo) para que la
     * guarda Condition.RequiresInvoiceAmount se compruebe de verdad contra el
     * total recien congelado y salga el correo de "Pendiente pago".
     * `skipPermission`: avanzar es consecuencia de una factura que armo el
     * sistema, no un acto que se le pueda exigir a quien escaneo el bulto.
     */
    if (to === State.FacturacionEnProceso && (await autoBillingService.tryAutoInvoice(session, row))) {
      return this.transition(
        session,
        id,
        { state: State.EnBodegaPendientePago, note: 'Costos aplicados automáticamente (tarifa sin revisión).' },
        { skipPermission: true },
      );
    }

    const updated = await shipmentsRepo.findById(id);
    if (!updated) throw ShipmentErrors.notFound();
    return updated;
  },

  /**
   * Corrige el estado de un tramite fuera de la maquina: la unica via para
   * retroceder o saltar, y existe porque hasta ahora un error de operacion no
   * tenia arreglo (el flujo es de un solo sentido en los tres flows).
   *
   * Se salta la barrera 1 (LEGALIDAD) a proposito: corregir es justamente ir a
   * donde la maquina no deja. Y no dispara la barrera 4 (efectos): una correccion
   * no le manda al cliente un correo diciendo que su paquete retrocedio. El
   * evento si se escribe.
   *
   * De la barrera 3 (CONDICIONES) se conserva UNA, la del monto de factura, y la
   * linea entre las que se saltan y esa no es arbitraria:
   *   - `RequiresConfirmedPayment` es POLITICA de proceso ("no despachar sin
   *     cobrar"). Un admin que corrige la realidad —el paquete salio a ruta y
   *     nadie lo marco— tiene que poder pasar por encima de ella.
   *   - `RequiresInvoiceAmount` es INTEGRIDAD de datos. "En bodega - Pendiente
   *     pago" le pinta al cliente un boton de pagar; sin monto, ese boton apunta
   *     a nada y devuelve un error. Saltarla no corrige un error, fabrica otro.
   *   - `RequiresComment` ya se cumple siempre: la nota es obligatoria aqui.
   *
   * Lo que NO hace, por decision de producto: tocar la factura. Si los costos ya
   * se aprobaron siguen congelados aunque el tramite vuelva antes de facturacion;
   * liberarlos es un acto aparte (`costsService.reverse`), con su propia guarda de
   * pagos. Corregir el estado y desarmar una factura son dos errores distintos.
   *
   * El permiso (`shipment.correct`, solo admin) lo aplica el middleware de la ruta.
   */
  async correct(session: Session, id: string, input: CorrectStateInput) {
    const row = await shipmentsRepo.findById(id);
    if (!row) throw ShipmentErrors.notFound();
    assertOperable(row);

    const flow = flowForType(row.shipmentType);
    const to = input.state;

    // Unica barrera que se conserva: el destino tiene que pertenecer a ESTA
    // maquina. Un estado de otro flow dejaria el tramite en un limbo del que ni
    // la correccion podria sacarlo (no aparece en `statesOf`, asi que no habria
    // camino de vuelta).
    if (!statesOf(flow).includes(to)) throw TransitionErrors.stateNotInFlow(STATE_LABELS[to]);
    if (to === row.state) throw TransitionErrors.sameState();

    // Integridad, no politica (ver cabecera): sin monto no se entra a un estado
    // que se lo muestra al cliente como cobrable.
    if (conditionsFor(flow, to).includes(Condition.RequiresInvoiceAmount) && row.invoiceTotalCrc == null) {
      throw TransitionErrors.requiresInvoiceAmount();
    }

    // El prefijo hace que el historial distinga una correccion de un avance real:
    // sin el, el timeline del tramite mentiria sobre como llego a ese estado.
    await shipmentsRepo.transition(id, to, session.userId, `Corrección: ${input.note}`);

    const updated = await shipmentsRepo.findById(id);
    if (!updated) throw ShipmentErrors.notFound();
    return updated;
  },
};
