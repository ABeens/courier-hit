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
 *    no es cobrar; un cargo aprobado por la pasarela si lo es. La unica excepcion
 *    es el deposito que registra quien ademas puede aprobarlo (ver `record`).
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
  billsAsGroup,
  PaymentMethod,
  PaymentStatus,
  Role,
  State,
  UNRESOLVED_PAYMENT_STATUSES,
  awaitsValidation,
  bankAccountsFor,
  canSetExchangeRate,
  exchangeRateSchema,
  isSettled,
  outstandingCrc,
  pendingAmount,
  recordedPaymentStatus,
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
import { consolidatedService } from './consolidated.service';
import { settingsRepo } from '../settings/settings.repo';
import { shipmentsRepo } from '../shipments/shipments.repo';
import { paymentsRepo } from './payments.repo';

/**
 * Fila del tramite sobre el que se cobra, con el casillero YA garantizado: los
 * medios de pago salen de la tarifa del dueño, asi que aqui dentro `clientId`
 * nunca es un hueco. Lo asegura `loadBillableShipment`.
 */
type ShipmentRow = NonNullable<Awaited<ReturnType<typeof shipmentsRepo.findById>>> & {
  clientId: string;
};
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
 * `exchange_rate.write`. No la referencia publicada: ese dato sirve para decidir la
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
  /**
   * Sin dueño no hay a quien cobrarle. En la practica no se llega aqui —un
   * paquete sin casillero no puede aprobar costos, asi que nunca tiene factura y
   * ya habria fallado arriba—, pero la comprobacion se escribe igual: es la que
   * garantiza el tipo del resto del modulo y la que sobrevive si algun dia se
   * factura por otra via.
   */
  if (row.clientId === null) throw ShipmentErrors.unassigned();
  return { ...row, clientId: row.clientId };
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

/**
 * UN PAQUETE DE CUENTA CONSOLIDADA NO SE PAGA SUELTO.
 *
 * Es la otra mitad de la regla del requisito ("el pago agrupado incluye
 * obligatoriamente todos los paquetes listos; debe restringirse la opcion de
 * excluir, quitar o agregar paquetes"). Sin este cerrojo la restriccion seria
 * decorativa: bastaria pagar los paquetes de uno en uno por el camino de siempre
 * para dejar fuera los que se quisiera.
 *
 * Vale para las DOS puertas de cobro, la del cliente y la del staff: un deposito
 * registrado contra un solo paquete consolidado rompe la agrupacion igual que un
 * pago con tarjeta. Quien tenga que cobrar de otra forma primero le cambia la
 * tarifa al casillero, que es una decision comercial y deja rastro.
 */
async function assertNotConsolidated(clientId: string): Promise<void> {
  const rate = await clientsRepo.rateFor(clientId);
  if (rate && billsAsGroup(rate.kind)) throw PaymentErrors.consolidatedRequired();
}

/**
 * Suelta los cobros con tarjeta que quedaron ABIERTOS y sin usar en un tramite.
 *
 * `abandonCard` cubre al cliente que cierra el formulario; esto cubre al que no
 * lo cierra (se le acaba la bateria, cambia de pestaña y la olvida, se le cae la
 * red). Sin barrerlos, cada intento deja su intento vivo en Onvo.
 *
 * MISMO ORDEN QUE EN `abandonCard`, y por lo mismo: primero se le pide a la
 * pasarela que cancele y solo si acepta se borra la fila. Si Onvo se niega, ese
 * cargo va en camino y NO se abre otro formulario: cobrar dos veces el mismo
 * saldo es peor que hacer esperar unos segundos.
 */
async function discardOpenCardAttempts(shipmentId: string): Promise<void> {
  const open = await paymentsRepo.openCardAttempts(shipmentId);

  for (const attempt of open) {
    if (
      attempt.gatewayReference &&
      !(await onvoClient.cancelPaymentIntent(attempt.gatewayReference))
    ) {
      throw PaymentErrors.cardAttemptInFlight();
    }
    await paymentsRepo.remove(attempt.id);
  }
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

    const [rate, paid, effectiveRate] = await Promise.all([
      clientsRepo.paymentOptionsFor(shipment.clientId),
      paymentsRepo.settlementView(shipmentId),
      clientsRepo.rateFor(shipment.clientId),
    ]);

    /**
     * La cuenta se cobra AGRUPADA: este tramite no se paga suelto. Viaja en la
     * cotizacion para que la pantalla lo diga en vez de ofrecer un formulario que
     * `start` va a rechazar (`assertNotConsolidated`).
     */
    const consolidated = effectiveRate ? billsAsGroup(effectiveRate.kind) : false;

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
      consolidated,
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

    // Cuenta consolidada: se paga el grupo entero, nunca un paquete suelto.
    await assertNotConsolidated(shipment.clientId);

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

    /**
     * Antes de abrir otro formulario de tarjeta se tiran los que quedaron
     * abiertos. Un cobro INICIADO no estorba a nadie, pero acumularlos si: cada
     * pestaña que el cliente cierra sin pagar deja su intento vivo en Onvo.
     */
    if (isCard) await discardOpenCardAttempts(input.shipmentId);

    const id = await paymentsRepo.insert({
      shipmentId: input.shipmentId,
      method: input.method,
      /**
       * El deposito nace PENDIENTE de validacion: el comprobante ya esta subido y
       * hay algo que revisar.
       *
       * La tarjeta nace INICIADA, que es un paso antes. Aqui todavia no se ha
       * intentado cobrar nada: la pasarela obliga a crear el intento para poder
       * pintar el formulario, asi que esta fila existe desde que el cliente abre
       * la pantalla. Nacida como `Pendiente` anunciaba un dinero en camino por el
       * solo hecho de mirar el formulario, bloqueaba el siguiente intento y le
       * ponia al staff un abono por validar que nadie podia resolver. Pasa a
       * `Pendiente` cuando el cargo sale de verdad (`markCardSubmitted`).
       */
      status: isCard ? PaymentStatus.Iniciado : PaymentStatus.Pendiente,
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

  /**
   * El staff registra un deposito que el cliente ya hizo ("Informacion de Pago"
   * del manual), tipicamente porque le mando el comprobante por fuera del portal.
   *
   * CON QUE SITUACION NACE LO DECIDE EL PERMISO, NO EL CUERPO
   * (`recordedPaymentStatus`):
   *
   *   - el Operativo (`payments.record`) lo deja PENDIENTE. El tramite pasa a
   *     "Pagado - en validacion": queda constancia de quien lo asento y con que
   *     respaldo, pero el dinero no se da por recibido y
   *     Condition.RequiresConfirmedPayment sigue sin cumplirse, asi que el
   *     paquete no sale a ruta por haberlo digitado;
   *   - el Administrador (`payments.validate`) lo deja CONFIRMADO, porque es el
   *     mismo que lo coteja contra el estado de cuenta y no tiene sentido que se
   *     resuelva a si mismo un abono en un segundo paso.
   *
   * QUIEN lo hizo queda en la fila (`createdBy`, y `confirmedBy` solo si ademas
   * lo aprobo): son dos sellos distintos justamente porque son dos actos.
   */
  async record(session: Session, input: RecordPaymentInput): Promise<PaymentDto> {
    const shipment = await loadBillableShipment(input.shipmentId);

    // Cuenta consolidada: el deposito se registra contra el grupo, no contra un
    // paquete (`consolidatedService.record`).
    await assertNotConsolidated(shipment.clientId);

    /**
     * La tasa es un valor general del sistema (ver `canSetExchangeRate`): quien
     * no puede fijarla registra el deposito con la de la factura, que es ademas
     * la que cuadra el abono con lo cobrado. Sin esta guarda, el permiso seria
     * cosmetico: el cuerpo admite tasa y el endpoint lo alcanza el Operativo.
     *
     * El `??` cubre al administrador que no la digita: puede fijarla, pero si no
     * la manda se cae a la misma fuente que el resto. En ningun camino se guarda
     * un monto sin tasa (regla M5).
     */
    const exchangeRate =
      (canSetExchangeRate(session.role) ? input.exchangeRate : undefined) ??
      invoiceExchangeRate(shipment, await settingsRepo.currentExchangeRate());

    const status = recordedPaymentStatus(session.role);
    const confirmed = status === PaymentStatus.Confirmado;

    const id = await paymentsRepo.insert({
      shipmentId: input.shipmentId,
      method: PaymentMethod.DepositoBancario,
      status,
      amount: roundMoney(input.amount, input.currency),
      currency: input.currency,
      exchangeRate,
      bankAccount: input.bankAccount,
      receiptNumber: input.receiptNumber,
      depositedAt: new Date(input.depositedAt),
      note: input.note ?? null,
      createdBy: session.userId,
      // Sin aprobacion no hay sello de aprobacion: un `confirmedBy` puesto al
      // registrar diria que alguien valido un abono que sigue en la bandeja.
      confirmedBy: confirmed ? session.userId : null,
      confirmedAt: confirmed ? new Date() : null,
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
      /**
       * Puede ser un COBRO AGRUPADO: ahi el intento de la pasarela es uno solo por
       * el total y cuelga del grupo, no de ninguno de sus abonos. Se intenta por
       * ese lado antes de dar la referencia por ajena.
       */
      const grouped = await consolidatedService.confirmByGateway(outcome);
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
