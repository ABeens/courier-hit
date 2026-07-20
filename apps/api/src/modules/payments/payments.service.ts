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
  Currency,
  PaymentMethod,
  PaymentStatus,
  Role,
  State,
  isSettled,
  roundMoney,
  settledAmount,
} from '@courier/shared';
import type {
  PaymentDto,
  RecordPaymentInput,
  ResolvePaymentInput,
  Session,
  StartPaymentInput,
} from '@courier/shared';
import { PaymentErrors, ShipmentErrors } from '../../core/errors';
import { storage } from '../../core/storage';
import { isOnvoEnabled, onvoClient } from '../../integrations/onvo/onvo.client';
import { clientsRepo } from '../clients/clients.repo';
import { exchangeRateProvider } from '../costs/exchange-rate';
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
 * El BCCR es el respaldo para el caso raro de una factura sin componente en
 * dolares (cociente indefinido). Si tampoco hay, no se inventa: se falla, porque
 * guardar un monto sin tasa es justo lo que la regla prohibe.
 */
function invoiceExchangeRate(row: ShipmentRow, suggested: number | null): number {
  const usd = row.invoiceTotalUsd ?? 0;
  const crc = row.invoiceTotalCrc ?? 0;
  if (usd > 0 && crc > 0) return crc / usd;
  if (suggested && suggested > 0) return suggested;
  throw PaymentErrors.exchangeRateUnavailable();
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
      /** Saldo pendiente en colones; nunca negativo (un sobrepago no genera deuda). */
      dueCrc: roundMoney(Math.max(0, (shipment.invoiceTotalCrc ?? 0) - settledCrc), Currency.CRC),
      settled: isSettled(paid, shipment.invoiceTotalCrc),
      availableMethods: methods,
      /** Datos de la cuenta para el deposito; los muestra la pantalla de pago. */
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

    // La tarifa manda sobre el medio de pago (decision 2).
    const rate = await clientsRepo.paymentOptionsFor(shipment.clientId);
    if (input.method === PaymentMethod.Tarjeta && !rate?.allowsCard) {
      throw PaymentErrors.methodNotAllowed();
    }
    if (input.method === PaymentMethod.DepositoBancario && rate && !rate.allowsBankDeposit) {
      throw PaymentErrors.methodNotAllowed();
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
    const suggestion = await exchangeRateProvider.suggest();
    const settledCrc = settledAmount(paid, Currency.CRC);
    const amount = roundMoney(
      Math.max(0, (shipment.invoiceTotalCrc ?? 0) - settledCrc),
      Currency.CRC,
    );

    const isCard = input.method === PaymentMethod.Tarjeta;
    const id = await paymentsRepo.insert({
      shipmentId: input.shipmentId,
      method: input.method,
      // El deposito nace pendiente de validacion; la tarjeta la resuelve la
      // pasarela y hasta entonces tambien esta pendiente (decision 3).
      status: PaymentStatus.Pendiente,
      amount,
      currency: Currency.CRC,
      exchangeRate: invoiceExchangeRate(shipment, suggestion.rate),
      bankAccount: input.bankAccount ?? null,
      receiptNumber: input.receiptNumber ?? null,
      depositedAt: input.depositedAt ? new Date(input.depositedAt) : null,
      createdBy: session.userId,
    });

    let intent = null;
    if (isCard) {
      intent = await onvoClient.createPaymentIntent({
        amount,
        currency: Currency.CRC,
        paymentId: id,
        description: `${shipment.code} — ${shipment.description}`,
      });
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
    await loadBillableShipment(input.shipmentId);

    const id = await paymentsRepo.insert({
      shipmentId: input.shipmentId,
      method: PaymentMethod.DepositoBancario,
      status: PaymentStatus.Confirmado,
      amount: roundMoney(input.amount, input.currency),
      currency: input.currency,
      exchangeRate: input.exchangeRate,
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
