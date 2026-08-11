/**
 * Reglas de negocio de los pagos (Parte 2 "Pagos" y Parte 3 "Información de Pago").
 *
 * Cinco decisiones que viven aqui y en ningun otro lado:
 *
 * 1. EL MONTO LO PONE EL SERVIDOR. Cuando paga el CLIENTE, el importe sale del
 *    monto de factura congelado del tramite, nunca del cuerpo de la peticion:
 *    dejar que el pagador declare cuanto debe seria confiar en el pagador.
 * 2. LA TARIFA FILTRA EL MEDIO DE PAGO. El manual es explicito: "Si el cliente
 *    esta asociado a una tarifa que no permite pago por tarjeta de credito no
 *    debe mostrar esa opcion". Ocultarla en la UI no basta: se revalida aqui.
 * 3. EL DEPOSITO NACE PENDIENTE, LA TARJETA NACE CONFIRMADA. Subir un comprobante
 *    no es cobrar; un cargo aprobado por la pasarela si lo es.
 * 4. "PAGADO" SE DERIVA, NO SE GUARDA. `isSettled` de @courier/shared responde
 *    contra los pagos confirmados. No hay un flag `pagado` que pueda mentir.
 * 5. EL PAGO NO MUEVE EL TRAMITE. Confirmar un pago cumple la guarda
 *    Condition.RequiresConfirmedPayment, pero quien saca el paquete a ruta es la
 *    operacion cuando lo carga al camion. Avanzar solo por haber cobrado pondria
 *    "En ruta de entrega" a un paquete que sigue en la estanteria.
 */
import {
  BANK_ACCOUNT_LABELS,
  Currency,
  PaymentMethod,
  PaymentStatus,
  Role,
  State,
  awaitsValidation,
  bankAccountsFor,
  canSetExchangeRate,
  exchangeRateSchema,
  isSettled,
  outstandingCrc,
  pendingAmount,
  roundMoney,
  settledAmount,
} from '@courier/shared';
import type {
  PaymentDto,
  RecordPaymentInput,
  ResolvePaymentInput,
  Session,
  StartPaymentInput,
  UpdateBankAccountInput,
} from '@courier/shared';
import { PaymentErrors, ShipmentErrors } from '../../core/errors';
import { storage } from '../../core/storage';
import {
  isOnvoEnabled,
  isOnvoSimulated,
  onvoClient,
} from '../../integrations/onvo/onvo.client';
import type { GatewayOutcome } from '../../integrations/onvo/onvo.client';
import { clientsRepo } from '../clients/clients.repo';
import { settingsRepo } from '../settings/settings.repo';
import { shipmentsRepo } from '../shipments/shipments.repo';
import { paymentsRepo } from './payments.repo';

type ShipmentRow = NonNullable<Awaited<ReturnType<typeof shipmentsRepo.findById>>>;
type PaymentRowView = Awaited<ReturnType<typeof paymentsRepo.findById>>;

/** Fila de BD -> DTO de la API (fechas en ISO/UTC). */
function toDto(row: NonNullable<PaymentRowView>): PaymentDto {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    method: row.method,
    status: row.status,
    amount: row.amount,
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
 * Tasa a congelar en un pago del cliente (regla M5).
 *
 * La fuente PRIMARIA es la propia factura: al aprobarse quedo congelada en las
 * dos monedas, y su cociente es la tasa con la que se construyo ese total. Usarla
 * mantiene la aritmetica cuadrada —el abono en colones dividido por esta tasa da
 * exactamente la porcion en dolares de la factura— mientras que tomar la tasa de
 * hoy dejaria una diferencia de centimos entre lo facturado y lo cobrado.
 *
 * El respaldo para el caso raro de una factura sin componente en dolares
 * (cociente indefinido) es la tasa GLOBAL del sistema, la que fijo quien tiene
 * `exchange_rate.write`. No el BCCR: ese dato es referencia para decidir la
 * global, no un valor con el que se guarde un monto. Si tampoco hay global, no
 * se inventa: se falla, porque guardar un monto sin tasa es justo lo que la
 * regla prohibe.
 *
 * Salga de donde salga, el valor pasa por el MISMO esquema que exige el cuerpo
 * (`exchangeRateSchema`): una tasa que impone el servidor no puede entrar por una
 * puerta con menos validacion que la que digita una persona. El cociente de la
 * factura no trae techo por si solo.
 */
function invoiceExchangeRate(row: ShipmentRow, globalRate: number | null): number {
  const usd = row.invoiceTotalUsd ?? 0;
  const crc = row.invoiceTotalCrc ?? 0;
  const rate = usd > 0 && crc > 0 ? crc / usd : globalRate;

  const checked = exchangeRateSchema.safeParse(rate);
  if (!checked.success) throw PaymentErrors.exchangeRateUnavailable();
  return checked.data;
}

/**
 * Tramite sobre el que se va a cobrar, con las dos comprobaciones que comparten
 * todas las vias de pago: que exista y que tenga factura aprobada.
 */
async function loadBillableShipment(shipmentId: string): Promise<ShipmentRow> {
  const row = await shipmentsRepo.findById(shipmentId);
  if (!row) throw ShipmentErrors.notFound();
  if (row.invoiceTotalCrc == null || row.invoiceTotalUsd == null) throw PaymentErrors.noInvoice();
  return row;
}

/** Un cliente solo puede pagar lo suyo (404, no 403: no revela existencia). */
function assertOwnership(session: Session, row: ShipmentRow): void {
  if (session.role !== Role.Client) return;
  if (!session.clientId) throw ShipmentErrors.missingClientProfile();
  if (row.clientId !== session.clientId) throw ShipmentErrors.notFound();
}

export const paymentsService = {
  /**
   * Lo que la pantalla de pago del cliente necesita para dibujarse: cuanto debe,
   * que medios tiene disponibles y que ya abono.
   *
   * Los medios salen de la TARIFA del cliente cruzada con lo que el sistema puede
   * cobrar hoy (la tarjeta exige la pasarela lista). Que el calculo viva en la API
   * evita que la web ofrezca un boton que el servidor va a rechazar.
   */
  async quote(session: Session, shipmentId: string) {
    const shipment = await loadBillableShipment(shipmentId);
    assertOwnership(session, shipment);

    const [rate, paid] = await Promise.all([
      clientsRepo.paymentOptionsFor(shipment.clientId),
      paymentsRepo.settlementView(shipmentId),
    ]);

    const settledCrc = settledAmount(paid, Currency.CRC);
    const settledUsd = settledAmount(paid, Currency.USD);
    const pendingCrc = pendingAmount(paid, Currency.CRC);

    const methods: PaymentMethod[] = [];
    if (rate?.allowsCard && isOnvoEnabled()) methods.push(PaymentMethod.Tarjeta);
    if (rate?.allowsBankDeposit ?? true) methods.push(PaymentMethod.DepositoBancario);

    return {
      shipmentId,
      shipmentCode: shipment.code,
      description: shipment.description,
      invoiceTotalUsd: shipment.invoiceTotalUsd,
      invoiceTotalCrc: shipment.invoiceTotalCrc,
      settledUsd,
      settledCrc,
      /** Abonos subidos y aun sin resolver. No es dinero recibido. */
      pendingCrc,
      /**
       * El mismo par en dolares. Va SIEMPRE, no solo en Paqueteria: la moneda en
       * que la pantalla le habla al cliente la decide `billingCurrencyFor`, y sin
       * las dos columnas tendria que reexpresar con la tasa de hoy, que no es la
       * que se congelo en cada abono (regla M5).
       */
      pendingUsd: pendingAmount(paid, Currency.USD),
      /** Saldo pendiente en colones; nunca negativo (un sobrepago no genera deuda). */
      dueCrc: outstandingCrc(settledCrc, shipment.invoiceTotalCrc),
      settled: isSettled(paid, shipment.invoiceTotalCrc),
      /**
       * El saldo ya esta cubierto por un abono en validacion: la pantalla debe
       * mostrar el comprobante en revision, no un formulario para pagar otra vez.
       * Lo decide el servidor con la MISMA funcion que rechaza el segundo pago en
       * `start`, para que no pueda ofrecer un boton que la API va a rechazar.
       */
      inValidation: awaitsValidation(settledCrc, pendingCrc, shipment.invoiceTotalCrc),
      availableMethods: methods,
      /**
       * A que cuentas puede depositar este tramite: Paqueteria solo las de
       * dolares, Transporte y Agenciamiento las de las dos monedas.
       *
       * Lo decide la API y no la web por la misma razon que `availableMethods`:
       * `start` revalida contra esta misma lista, asi que una pantalla que
       * ofreciera otra cosa solo produciria un rechazo. Los numeros de cuenta no
       * viajan aqui, los pone la web desde `BANK_ACCOUNTS`: son constantes del
       * dominio compartido, no un dato de este tramite.
       */
      availableBankAccounts: bankAccountsFor(shipment.shipmentType),
      payableState: shipment.state === State.EnBodegaPendientePago,
    };
  },

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
   * El cliente inicia un pago. Devuelve el pago creado y, si es con tarjeta, el
   * intento de la pasarela para que el navegador abra el formulario.
   */
  async start(
    session: Session,
    input: StartPaymentInput,
  ): Promise<{ payment: PaymentDto; intent: Awaited<ReturnType<typeof onvoClient.createPaymentIntent>> | null }> {
    const shipment = await loadBillableShipment(input.shipmentId);
    assertOwnership(session, shipment);

    if (shipment.state !== State.EnBodegaPendientePago) throw PaymentErrors.notPayableState();

    const paid = await paymentsRepo.settlementView(input.shipmentId);
    if (isSettled(paid, shipment.invoiceTotalCrc)) throw PaymentErrors.alreadySettled();

    /**
     * UN SOLO PAGO ABIERTO POR SALDO. Con un abono que ya cubre lo que falta y
     * sigue sin validar, el tramite no admite otro: el segundo cobraria de nuevo
     * el mismo saldo (el importe lo pone el servidor y el pendiente no lo baja),
     * y quien lo valide se encontraria con dos comprobantes por una sola deuda.
     *
     * Que la pantalla ya esconda el boton no basta: la peticion se puede repetir
     * desde una pestaña vieja, desde el reintento de una red lenta o a mano.
     * Cobrar dos veces al cliente es justo el fallo que no se puede dejar a la UI.
     *
     * No cierra la puerta para siempre: un pago RECHAZADO deja de estar pendiente
     * y el cliente puede volver a intentarlo enseguida.
     */
    if (
      awaitsValidation(
        settledAmount(paid, Currency.CRC),
        pendingAmount(paid, Currency.CRC),
        shipment.invoiceTotalCrc,
      )
    ) {
      throw PaymentErrors.inValidation();
    }

    // La tarifa manda sobre el medio de pago (decision 2).
    const rate = await clientsRepo.paymentOptionsFor(shipment.clientId);
    if (input.method === PaymentMethod.Tarjeta && !rate?.allowsCard) {
      throw PaymentErrors.methodNotAllowed();
    }
    if (input.method === PaymentMethod.DepositoBancario && rate && !rate.allowsBankDeposit) {
      throw PaymentErrors.methodNotAllowed();
    }

    /**
     * La cuenta tiene que ser una de las que este tramite admite (Paqueteria solo
     * las de dolares). Se revalida aqui y no solo en el select por lo de siempre:
     * el cuerpo de la peticion se puede escribir a mano. El esquema Zod ya exigio
     * que venga una en los depositos; lo que no podia saber es CUALES valen, que
     * depende del tipo de tramite.
     */
    if (
      input.method === PaymentMethod.DepositoBancario &&
      input.bankAccount &&
      !bankAccountsFor(shipment.shipmentType).includes(input.bankAccount)
    ) {
      throw PaymentErrors.bankAccountNotAllowed();
    }

    /**
     * Se cobra el SALDO pendiente, no el total: si el cliente ya abono una parte
     * por deposito, la tarjeta solo debe llevarse lo que falta.
     *
     * Moneda y tasa (reglas M2 y M5): se cobra en colones —la moneda local de
     * cobro— y se congela la tasa del dia. Que la tasa se guarde aqui, y no se
     * relea al mostrar, es lo que permite reexpresar el abono en dolares mañana
     * sin que la cifra cambie sola.
     */
    const globalRate = await settingsRepo.currentExchangeRate();
    const amount = outstandingCrc(settledAmount(paid, Currency.CRC), shipment.invoiceTotalCrc);

    const isCard = input.method === PaymentMethod.Tarjeta;
    const id = await paymentsRepo.insert({
      shipmentId: input.shipmentId,
      method: input.method,
      // El deposito nace pendiente de validacion; la tarjeta la resuelve la
      // pasarela y hasta entonces tambien esta pendiente (decision 3).
      status: PaymentStatus.Pendiente,
      amount,
      currency: Currency.CRC,
      exchangeRate: invoiceExchangeRate(shipment, globalRate),
      bankAccount: input.bankAccount ?? null,
      receiptNumber: input.receiptNumber ?? null,
      depositedAt: input.depositedAt ? new Date(input.depositedAt) : null,
      createdBy: session.userId,
    });

    let intent = null;
    if (isCard) {
      /**
       * Si la pasarela falla, el pago que acabamos de insertar se borra. Dejarlo
       * seria peor que no haberlo creado: nace PENDIENTE, asi que aparecería en la
       * bandeja de validacion del staff como un deposito por revisar que nadie
       * puede resolver, y ademas sin comprobante. No hay rastro que perder porque
       * ese abono nunca existio: el cobro no llego a intentarse.
       */
      try {
        intent = await onvoClient.createPaymentIntent({
          amount,
          currency: Currency.CRC,
          paymentId: id,
          description: `${shipment.code} — ${shipment.description}`,
        });
      } catch (err) {
        await paymentsRepo.remove(id);
        throw err;
      }
      await paymentsRepo.update(id, { gatewayReference: intent.reference });
    }

    const row = await paymentsRepo.findById(id);
    if (!row) throw PaymentErrors.notFound();
    return { payment: toDto(row), intent };
  },

  /** Adjunta el comprobante del deposito a un pago propio aun pendiente. */
  async attachReceipt(session: Session, paymentId: string, file: File): Promise<PaymentDto> {
    const payment = await paymentsRepo.findById(paymentId);
    if (!payment) throw PaymentErrors.notFound();
    if (payment.status !== PaymentStatus.Pendiente) throw PaymentErrors.alreadyResolved();

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

  /**
   * El staff registra un deposito ya recibido ("Informacion de Pago" del manual).
   * Nace CONFIRMADO: quien lo digita es quien lo vio en el estado de cuenta.
   */
  async record(session: Session, input: RecordPaymentInput): Promise<PaymentDto> {
    const shipment = await loadBillableShipment(input.shipmentId);

    /**
     * La tasa es un valor general del sistema (ver `canSetExchangeRate`): quien
     * no puede fijarla registra el deposito con la de la factura, que es ademas
     * la que cuadra el abono con lo cobrado. Sin esta guarda, el permiso seria
     * cosmetico: `payments.validate` alcanza este endpoint y el cuerpo trae tasa.
     */
    const exchangeRate = canSetExchangeRate(session.role)
      ? input.exchangeRate
      : invoiceExchangeRate(shipment, await settingsRepo.currentExchangeRate());

    const id = await paymentsRepo.insert({
      shipmentId: input.shipmentId,
      method: PaymentMethod.DepositoBancario,
      status: PaymentStatus.Confirmado,
      amount: roundMoney(input.amount, input.currency),
      currency: input.currency,
      exchangeRate,
      bankAccount: input.bankAccount,
      receiptNumber: input.receiptNumber,
      depositedAt: new Date(input.depositedAt),
      note: input.note ?? null,
      createdBy: session.userId,
      confirmedBy: session.userId,
      confirmedAt: new Date(),
    });

    const row = await paymentsRepo.findById(id);
    if (!row) throw PaymentErrors.notFound();
    return toDto(row);
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

    if (!updated) return { applied: false, reason: 'already_resolved' };
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
