/**
 * Reglas de negocio de los pagos (Parte 2 "Pagos" y Parte 3 "Información de Pago").
 *
 * Con el modulo de proformas, COBRAR es un acto sobre proformas: el cliente paga
 * y el staff registra depositos por proformas completas, en
 * `proforma-payments.service`. Este modulo conserva lo que es de cada abono: la
 * bandeja, la validacion del administrador, el webhook de la pasarela, la cuenta
 * del deposito y los comprobantes.
 *
 * Tres decisiones que siguen viviendo aqui:
 *
 * 1. "PAGADO" SE DERIVA, NO SE GUARDA. `isSettled` de @courier/shared responde
 *    contra los pagos confirmados. No hay un flag `pagado` en el tramite que
 *    pueda mentir (la marca de la proforma la escribe `proformaSettlement` desde
 *    esos mismos abonos).
 * 2. EL PAGO NO MUEVE EL TRAMITE. Confirmar un pago cumple la guarda
 *    Condition.RequiresConfirmedPayment, pero quien saca el paquete a ruta es la
 *    operacion cuando lo carga al camion.
 * 3. TODO CAMINO DE CONFIRMACION RESINCRONIZA LA PROFORMA. Webhook y validacion
 *    llaman a `proformaSettlement`, que marca pagada la proforma cuando el ultimo
 *    de sus tramites se salda.
 */
import {
  BANK_ACCOUNT_LABELS,
  PaymentMethod,
  PaymentStatus,
  Role,
  UNRESOLVED_PAYMENT_STATUSES,
} from '@courier/shared';
import type {
  PaymentDto,
  ResolvePaymentInput,
  Session,
  UpdateBankAccountInput,
} from '@courier/shared';
import { PaymentErrors, ShipmentErrors } from '../../core/errors';
import { storage } from '../../core/storage';
import { isOnvoSimulated, onvoClient } from '../../integrations/onvo/onvo.client';
import type { GatewayOutcome } from '../../integrations/onvo/onvo.client';
import { costsService } from '../costs/costs.service';
import { shipmentsRepo } from '../shipments/shipments.repo';
import { proformaSettlement } from '../proformas/proforma-settlement';
import { paymentsRepo } from './payments.repo';
import { proformaPaymentsService } from './proforma-payments.service';

type PaymentRowView = Awaited<ReturnType<typeof paymentsRepo.findById>>;

/** Fila de BD -> DTO de la API (fechas en ISO/UTC). */
function toDto(row: NonNullable<PaymentRowView>): PaymentDto {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    groupId: row.groupId,
    method: row.method,
    status: row.status,
    amount: row.amount,
    surchargeAmount: row.surchargeAmount,
    currency: row.currency,
    exchangeRate: row.exchangeRate,
    bankAccount: row.bankAccount,
    receiptNumber: row.receiptNumber,
    depositedAt: row.depositedAt?.toISOString() ?? null,
    receiptFileKey: row.receiptFileKey,
    gatewayReference: row.gatewayReference,
    note: row.note,
    createdByName: row.createdByName,
    confirmedByName: row.confirmedByName,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Un cliente solo puede pagar lo suyo (404, no 403: no revela existencia).
 *
 * Pide el casillero suelto y no un `ShipmentRow` porque tambien la llaman las
 * rutas que arrancan de un pago y cargan el tramite crudo, sin pasar por
 * `loadBillableShipment`. Un tramite sin dueño nunca es "lo suyo" de nadie: el
 * `!==` contra un `null` niega el acceso, que es lo correcto.
 */
function assertOwnership(session: Session, row: { clientId: string | null }): void {
  if (session.role !== Role.Client) return;
  if (!session.clientId) throw ShipmentErrors.missingClientProfile();
  if (row.clientId !== session.clientId) throw ShipmentErrors.notFound();
}

export const paymentsService = {
  /** Pagos de un tramite (el cliente ve los suyos; el staff, los de cualquiera). */
  async listByShipment(session: Session, shipmentId: string): Promise<{ items: PaymentDto[] }> {
    const shipment = await shipmentsRepo.findById(shipmentId);
    if (!shipment) throw ShipmentErrors.notFound();
    assertOwnership(session, shipment);

    const rows = await paymentsRepo.listByShipment(shipmentId);
    return { items: rows.map(toDto) };
  },

  /** Bandeja del staff: pagos por validar. */
  async list(filters: { shipmentId?: string; status?: string }): Promise<{ items: PaymentDto[] }> {
    const status = Object.values(PaymentStatus).find((s) => s === filters.status);
    const rows = await paymentsRepo.list({ shipmentId: filters.shipmentId, status });
    return { items: rows.map(toDto) };
  },

  /**
   * El navegador termino de mandarle la tarjeta a la pasarela. A partir de aqui
   * SI hay un cargo en camino, asi que el cobro deja de ser un formulario abierto
   * y pasa a contar como abono a la espera del webhook: suma en el pendiente que
   * ve el cliente y bloquea un segundo cobro por el mismo saldo.
   *
   * NO confirma nada. Quien dice si se cobro es el webhook (`confirmByGateway`);
   * esto solo mueve el pago de "abierto" a "en camino". Creerle al navegador para
   * dar por cobrado seria anunciar como pagado un cargo que la pasarela todavia
   * puede rechazar.
   *
   * Es idempotente y no falla si llega tarde: el webhook puede haber resuelto ya
   * el cobro, y entonces esto no toca nada y devuelve lo que hay. Un error aqui
   * solo le enseñaria al cliente un fallo por un pago que salio bien.
   */
  async markCardSubmitted(session: Session, paymentId: string): Promise<PaymentDto> {
    const payment = await paymentsRepo.findById(paymentId);
    if (!payment) throw PaymentErrors.notFound();

    const shipment = await shipmentsRepo.findById(payment.shipmentId);
    if (!shipment) throw ShipmentErrors.notFound();
    assertOwnership(session, shipment);

    if (payment.method !== PaymentMethod.Tarjeta) throw PaymentErrors.methodNotAllowed();

    await paymentsRepo.markSubmitted(paymentId);

    const updated = await paymentsRepo.findById(paymentId);
    if (!updated) throw PaymentErrors.notFound();
    return toDto(updated);
  },

  /**
   * El cliente cerro el formulario de tarjeta sin llegar a pagar. Es la otra
   * mitad de `start`: ahi se reserva el cobro, aqui se suelta.
   *
   * Sin esto el pago se queda PENDIENTE para siempre, y un pendiente no es
   * inofensivo: cuenta como abono en validacion, bloquea el siguiente intento
   * (`start` lanza `inValidation`) y le anuncia al cliente un dinero que nadie
   * cobro. Abrir el modal y cerrarlo dejaba el tramite trabado hasta que un
   * administrador rechazaba a mano un cobro que nunca existio.
   *
   * EL ORDEN NO ES NEGOCIABLE: primero se le pide a Onvo que cancele el intento
   * y SOLO si Onvo confirma que quedo cancelado se deshace el pago aqui. Al
   * reves habria una ventana en la que borramos la fila y el cobro sale igual:
   * el webhook llegaria sin ninguna referencia que tocar y el cliente habria
   * pagado sin que quede rastro en el sistema. Si Onvo se niega —porque el cobro
   * ya iba en camino— el pago se queda intacto y lo resuelve el webhook, que es
   * justo lo que tiene que pasar.
   */
  async abandonCard(session: Session, paymentId: string): Promise<{ cancelled: boolean }> {
    const payment = await paymentsRepo.findById(paymentId);
    if (!payment) throw PaymentErrors.notFound();

    const shipment = await shipmentsRepo.findById(payment.shipmentId);
    if (!shipment) throw ShipmentErrors.notFound();
    assertOwnership(session, shipment);

    // Un deposito pendiente espera a una persona y no se suelta solo; uno ya
    // resuelto no se toca. Esto vale unicamente para el cobro a medias, que es
    // tanto el formulario abierto y sin usar (`Iniciado`) como el cargo que salio
    // y todavia espera al webhook (`Pendiente`): de ese segundo se encarga Onvo,
    // que se negara a cancelarlo.
    if (payment.method !== PaymentMethod.Tarjeta) throw PaymentErrors.methodNotAllowed();
    if (!UNRESOLVED_PAYMENT_STATUSES.includes(payment.status)) {
      throw PaymentErrors.alreadyResolved();
    }
    if (!payment.gatewayReference) throw PaymentErrors.notFound();

    if (!(await onvoClient.cancelPaymentIntent(payment.gatewayReference))) {
      return { cancelled: false };
    }

    /**
     * Se BORRA en vez de dejarlo rechazado, por la misma razon por la que `start`
     * borra el pago cuando la pasarela falla: no hubo cobro, asi que no hay nada
     * que registrar. Un abono rechazado seria una linea en el historial del
     * cliente por un cargo que nunca ocurrio, y en la bandeja del staff, ruido.
     */
    await paymentsRepo.remove(paymentId);
    return { cancelled: true };
  },

  /**
   * Adjunta el comprobante del deposito. Es el RESPALDO del abono, no parte de
   * resolverlo, y por eso la ventana no es la misma para todos:
   *
   *   - el CLIENTE solo alcanza su pago mientras esta PENDIENTE. Su comprobante
   *     es la peticion de que le validen el deposito; una vez resuelta, cambiar
   *     el archivo seria mover la prueba debajo de una decision ya tomada;
   *   - el STAFF tambien lo adjunta a uno ya CONFIRMADO, porque el administrador
   *     registra el abono confirmado de un solo golpe (`record`) y el archivo va
   *     en una segunda peticion: sin esta ventana, el unico deposito que no
   *     podria llevar respaldo seria justo el que asienta quien lo valido.
   *
   * A un abono RECHAZADO no se le adjunta nada: no hay cobro que respaldar, y el
   * cliente que quiera reintentar registra otro.
   */
  async attachReceipt(session: Session, paymentId: string, file: File): Promise<PaymentDto> {
    const payment = await paymentsRepo.findById(paymentId);
    if (!payment) throw PaymentErrors.notFound();

    const staff = session.role !== Role.Client;
    const open =
      payment.status === PaymentStatus.Pendiente ||
      (staff && payment.status === PaymentStatus.Confirmado);
    if (!open) throw PaymentErrors.alreadyResolved();

    const shipment = await shipmentsRepo.findById(payment.shipmentId);
    if (!shipment) throw ShipmentErrors.notFound();
    assertOwnership(session, shipment);

    const key = await storage.put('receipts', file);
    // Reemplazar el comprobante borra el anterior: dejarlo huerfano solo acumula
    // basura en el almacen que ya nadie puede alcanzar.
    if (payment.receiptFileKey) await storage.remove(payment.receiptFileKey);
    await paymentsRepo.update(paymentId, { receiptFileKey: key });

    const updated = await paymentsRepo.findById(paymentId);
    if (!updated) throw PaymentErrors.notFound();
    return toDto(updated);
  },

  /** Confirma o rechaza un deposito pendiente. */
  async resolve(
    session: Session,
    paymentId: string,
    input: ResolvePaymentInput,
  ): Promise<PaymentDto> {
    const payment = await paymentsRepo.findById(paymentId);
    if (!payment) throw PaymentErrors.notFound();
    if (payment.status !== PaymentStatus.Pendiente) throw PaymentErrors.alreadyResolved();

    await paymentsRepo.update(paymentId, {
      status: input.confirm ? PaymentStatus.Confirmado : PaymentStatus.Rechazado,
      note: input.note ?? payment.note,
      confirmedBy: session.userId,
      confirmedAt: new Date(),
    });

    /**
     * Mismo asiento que en el webhook, por el otro camino: un cobro con tarjeta
     * que se queda colgado y lo resuelve el staff a mano tiene que dejar la
     * factura igual que si lo hubiera resuelto la pasarela. En un deposito no
     * hace nada: no lleva recargo.
     */
    if (input.confirm) {
      await costsService.postCardSurcharge(payment);
      // La proforma queda pagada cuando el ultimo de sus tramites se salda.
      await proformaSettlement.syncForShipments([payment.shipmentId]);
    }

    const updated = await paymentsRepo.findById(paymentId);
    if (!updated) throw PaymentErrors.notFound();
    return toDto(updated);
  },

  /**
   * El staff CORRIGE a que cuenta entro un deposito ("un operario o
   * administrador luego puede indicar que se deposito a otro tipo de cuenta").
   *
   * Tres decisiones:
   *
   * 1. VALE EN CUALQUIER SITUACION DEL PAGO, tambien confirmado. El estado de
   *    cuenta suele aparecer despues de haber dado el abono por bueno, y es
   *    justo entonces cuando se descubre que el dinero no estaba donde el
   *    cliente dijo. Limitarlo a los pendientes dejaria el dato imposible de
   *    arreglar en el unico momento en que se sabe que esta mal.
   * 2. SIN EL FILTRO POR TIPO DE TRAMITE (`bankAccountsForStaff`). El filtro
   *    orienta al cliente sobre donde depositar; el operario registra lo que el
   *    banco dice, y ahi el sistema no tiene nada que opinar.
   * 3. DEJA RASTRO EN LA NOTA. La cuenta anterior se conserva ahi: es un dato de
   *    conciliacion, y perder el valor viejo en silencio convierte una
   *    correccion en una discusion sin evidencia. El monto, la moneda y la tasa
   *    siguen intocables (son snapshot).
   */
  async updateBankAccount(
    _session: Session,
    paymentId: string,
    input: UpdateBankAccountInput,
  ): Promise<PaymentDto> {
    const payment = await paymentsRepo.findById(paymentId);
    if (!payment) throw PaymentErrors.notFound();
    if (payment.method !== PaymentMethod.DepositoBancario) {
      throw PaymentErrors.bankAccountNotApplicable();
    }

    // Cambiarla por la que ya tiene no es un error, pero tampoco merece una
    // linea de rastro que solo ensucia la nota.
    if (payment.bankAccount === input.bankAccount) return toDto(payment);

    const previous = payment.bankAccount
      ? BANK_ACCOUNT_LABELS[payment.bankAccount]
      : 'sin cuenta registrada';
    const trail = `Cuenta corregida de ${previous} a ${BANK_ACCOUNT_LABELS[input.bankAccount]}.`;

    await paymentsRepo.update(paymentId, {
      bankAccount: input.bankAccount,
      note: [payment.note, input.note?.trim(), trail].filter(Boolean).join(' '),
    });

    const updated = await paymentsRepo.findById(paymentId);
    if (!updated) throw PaymentErrors.notFound();
    return toDto(updated);
  },

  /**
   * Confirma o rechaza un pago con tarjeta por orden de la PASARELA, no de una
   * persona. Lo llama el webhook de Onvo y el flujo simulado.
   *
   * Va aparte de `resolve` por tres razones, y las tres importan:
   *
   * 1. NO HAY SESION. `resolve` sella `confirmedBy` con el usuario que valida; aqui
   *    no hay usuario. `confirmedBy` queda en null y la nota dice de donde vino.
   * 2. NO HAY PERMISO QUE COMPROBAR. La autorizacion la dio el header del webhook
   *    antes de llegar aqui; repetir una comprobacion de rol no tendria a quien
   *    preguntarle.
   * 3. TIENE QUE SER IDEMPOTENTE. Onvo reintenta las entregas y su evento no trae
   *    id propio, asi que el mismo cobro puede llegar dos veces. `resolveIfPending`
   *    resuelve en una sola sentencia condicionada; la repeticion no encuentra fila
   *    y se ignora en silencio, que es lo correcto: no es un error del emisor.
   *
   * Devuelve que paso, para que quien llame pueda registrarlo sin volver a leer.
   */
  async confirmByGateway(
    outcome: GatewayOutcome,
  ): Promise<{ applied: boolean; reason: 'ok' | 'unknown_reference' | 'already_resolved' }> {
    const payment = await paymentsRepo.findByGatewayReference(outcome.reference);
    if (!payment) {
      /**
       * Es un COBRO DE PROFORMAS (el caso normal): ahi el intento de la pasarela es
       * uno solo por el total y cuelga del grupo, no de ninguno de sus abonos. Se intenta por
       * ese lado antes de dar la referencia por ajena.
       */
      const grouped = await proformaPaymentsService.confirmByGateway(outcome);
      if (grouped.reason !== 'unknown_reference') return grouped;

      // Puede ser un cobro de otra cuenta o de otro entorno apuntando al mismo
      // webhook. Se registra y se ignora: no es motivo para responder un error.
      console.warn(`[payments] webhook con referencia desconocida: ${outcome.reference}`);
      return { applied: false, reason: 'unknown_reference' };
    }

    const note = outcome.approved
      ? 'Cobro aprobado por la pasarela.'
      : `Cobro rechazado por la pasarela.${outcome.detail ? ` ${outcome.detail}` : ''}`;

    const updated = await paymentsRepo.resolveIfPending(payment.id, {
      status: outcome.approved ? PaymentStatus.Confirmado : PaymentStatus.Rechazado,
      note,
      confirmedAt: new Date(),
    });

    /**
     * EL RECARGO SE ASIENTA TAMBIEN EN EL REINTENTO. El cobro ya estaba resuelto,
     * pero el asiento pudo haberse quedado sin hacer: un fallo de BD justo
     * despues de confirmar, o —lo que ya paso una vez— un cobro confirmado por
     * una version anterior que todavia no sabia asentarlo.
     *
     * Sin esto, el primer intento fallido era definitivo: la segunda entrega del
     * webhook salia por `already_resolved` y la comision se quedaba fuera de la
     * factura para siempre. Reintentarlo es gratis porque el asiento es
     * idempotente (unico sobre `payment_id`).
     *
     * OJO con los cobros anteriores a este mecanismo: los que se confirmaron
     * cuando el abono guardaba solo el saldo (sin el recargo dentro) quedarian
     * con la factura 0,78 por encima de lo abonado. Esos se arreglan corrigiendo
     * el abono, no aqui.
     */
    if (!updated) {
      if (outcome.approved && payment.status === PaymentStatus.Confirmado) {
        await costsService.postCardSurcharge(payment);
      }
      return { applied: false, reason: 'already_resolved' };
    }

    /**
     * Cobro aprobado: la comision que se le cargo de mas al cliente se asienta
     * como costo trasladado y sube la factura del tramite.
     *
     * En un cobro RECHAZADO no se asienta nada: no hubo comision que pagar.
     */
    if (outcome.approved) {
      await costsService.postCardSurcharge(payment);
      await proformaSettlement.syncForShipments([payment.shipmentId]);
    }

    return { applied: true, reason: 'ok' };
  },

  /**
   * Flujo de PRUEBA: resuelve un pago con tarjeta simulado sin pasar por Onvo.
   *
   * Existe para que la ausencia de credenciales no bloquee las pruebas del flujo
   * completo. Tres cerrojos, porque un endpoint que confirma pagos sin cobrar es
   * exactamente lo que un atacante querria:
   *
   *   - solo con la pasarela en modo simulado (en produccion ni siquiera arranca);
   *   - solo sobre un pago cuya referencia nacio simulada, para que no pueda tocar
   *     un cobro real que quedo pendiente;
   *   - solo sobre un tramite del propio cliente (misma regla de siempre).
   */
  async simulateGatewayOutcome(
    session: Session,
    paymentId: string,
    approve: boolean,
  ): Promise<PaymentDto> {
    if (!isOnvoSimulated()) throw PaymentErrors.simulationNotAllowed();

    const payment = await paymentsRepo.findById(paymentId);
    if (!payment) throw PaymentErrors.notFound();
    if (!payment.gatewayReference || !onvoClient.isSimulatedReference(payment.gatewayReference)) {
      throw PaymentErrors.simulationNotAllowed();
    }

    const shipment = await shipmentsRepo.findById(payment.shipmentId);
    if (!shipment) throw ShipmentErrors.notFound();
    assertOwnership(session, shipment);

    await paymentsService.confirmByGateway(
      onvoClient.simulateOutcome(payment.gatewayReference, approve),
    );

    const updated = await paymentsRepo.findById(paymentId);
    if (!updated) throw PaymentErrors.notFound();
    return toDto(updated);
  },

  /** Descarga del comprobante. El cliente solo alcanza el suyo. */
  async receiptFile(session: Session, paymentId: string) {
    const payment = await paymentsRepo.findById(paymentId);
    if (!payment?.receiptFileKey) throw PaymentErrors.receiptRequired();

    const shipment = await shipmentsRepo.findById(payment.shipmentId);
    if (!shipment) throw ShipmentErrors.notFound();
    assertOwnership(session, shipment);

    return storage.get(payment.receiptFileKey);
  },
};
