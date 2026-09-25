/**
 * COBRO DE PROFORMAS (docs/proformas-cambios.html, area 5).
 *
 * El cliente elige cuales de sus proformas aprobadas paga, y un solo cobro
 * (tarjeta o deposito) puede cubrir varias. Reemplaza al cobro consolidado y al
 * pago tramite por tramite: todo se paga por proforma completa (decision D2).
 *
 * Las reglas, y donde se cumplen:
 *
 * 1. PROFORMAS COMPLETAS. El importe es el saldo entero de las proformas elegidas
 *    y lo pone el servidor; ni el cliente ni el staff mandan un monto. No hay
 *    forma de pagar parte de una proforma (regla 6 del SOW).
 * 2. SOLO APROBADAS Y DEL PROPIO CLIENTE. Un borrador no se cobra y una pagada ya
 *    se saldo; una proforma de otro casillero se responde como inexistente.
 * 3. UNA MONEDA POR COBRO. Cada proforma se cobra en la moneda de su flujo, y un
 *    cobro no mezcla dolares con colones.
 *
 * COMO SE GUARDA. Una fila en `payment_groups` (el cobro) y un abono en
 * `payments` por cada tramite de las proformas elegidas, apuntando al grupo. Cada
 * abono lleva el saldo de SU tramite (su factura ya incluye su parte de los
 * servicios de la proforma, ver `allocateProformaInvoices`), asi que la suma da el
 * total exacto y todo lo que pregunta "este tramite esta pagado" sigue igual. La
 * comision de la tarjeta es una sola y se reparte entre los tramites.
 *
 * Al confirmarse el cobro, `proformaSettlement` marca pagadas las proformas cuyos
 * tramites quedaron todos saldados.
 *
 * LA TASA (regla M5). Cada abono congela la de SU factura; el grupo guarda la del
 * cobro completo (total en colones sobre total en dolares).
 */
import {
  Currency,
  Flow,
  PaymentMethod,
  PaymentStatus,
  ProformaStatus,
  Role,
  ShipmentType,
  UNRESOLVED_PAYMENT_STATUSES,
  awaitsValidation,
  bankAccountsFor,
  canSetExchangeRate,
  cardChargeFor,
  chargeBasisIn,
  exchangeRateSchema,
  formatProformaNumber,
  isSettled,
  outstandingFor,
  paymentGroupStatus,
  pendingAmount,
  recordedPaymentStatus,
  roundMoney,
  settledAmount,
  splitAmount,
} from '@courier/shared';
import type {
  BankAccount,
  ChargeBasis,
  PaymentGroupDto,
  ProformaPaymentItem,
  ProformaPaymentQuoteDto,
  RecordProformaPaymentInput,
  ResolvePaymentGroupInput,
  Session,
  StartProformaPaymentInput,
} from '@courier/shared';
import { PaymentErrors, ProformaErrors, ShipmentErrors } from '../../core/errors';
import { storage } from '../../core/storage';
import { isOnvoEnabled, isOnvoSimulated, onvoClient } from '../../integrations/onvo/onvo.client';
import type { GatewayOutcome } from '../../integrations/onvo/onvo.client';
import { costsService } from '../costs/costs.service';
import { proformaSettlement } from '../proformas/proforma-settlement';
import { settingsRepo } from '../settings/settings.repo';
import { settingsService } from '../settings/settings.service';
import { paymentGroupsRepo } from './payment-groups.repo';
import type { PayableRow } from './payment-groups.repo';
import { paymentsRepo } from './payments.repo';

/** Un tipo de tramite representativo de cada flujo, para las cuentas bancarias. */
const FLOW_SAMPLE_TYPE: Record<Flow, ShipmentType> = {
  [Flow.Paqueteria]: ShipmentType.Paqueteria,
  [Flow.Transporte]: ShipmentType.Aereo,
  [Flow.Agenciamiento]: ShipmentType.Agenciamiento,
};

/**
 * De que casillero se habla. El cliente solo alcanza el suyo; el staff indica
 * cual. Que el alcance no dependa de que la pantalla mande el id correcto.
 */
function targetClientId(session: Session, requested?: string): string {
  if (session.role === Role.Client) {
    if (!session.clientId) throw ShipmentErrors.missingClientProfile();
    return session.clientId;
  }
  if (!requested) throw ShipmentErrors.notFound();
  return requested;
}

/** La factura del tramite en la moneda del cobro. */
function invoiceIn(row: PayableRow, currency: Currency): number | null {
  return currency === Currency.USD ? row.invoiceTotalUsd : row.invoiceTotalCrc;
}

/** La base con la que se liquida UN tramite: moneda del cobro y su factura en ella. */
function basisOfRow(row: PayableRow, currency: Currency): ChargeBasis {
  return chargeBasisIn(currency, invoiceIn(row, currency));
}

/** El saldo de UN tramite en la moneda del cobro: lo que se le va a abonar. */
function dueOf(row: PayableRow, currency: Currency): number {
  return outstandingFor(settledAmount(row.settlement, currency), basisOfRow(row, currency));
}

/**
 * Tasa con la que se congela el abono de UN tramite (regla M5): el cociente de su
 * propia factura, que es el unico que deja la aritmetica del tramite cuadrada, y
 * solo si no existe, la global del sistema.
 */
function rateFor(row: PayableRow, globalRate: number | null): number {
  const usd = row.invoiceTotalUsd ?? 0;
  const crc = row.invoiceTotalCrc ?? 0;
  const checked = exchangeRateSchema.safeParse(usd > 0 && crc > 0 ? crc / usd : globalRate);
  if (!checked.success) throw PaymentErrors.exchangeRateUnavailable();
  return checked.data;
}

/** Suma redondeada en la moneda del cobro (M4). */
function sum(values: readonly number[], currency: Currency): number {
  return roundMoney(values.reduce((acc, v) => acc + v, 0), currency);
}

/** Una proforma de la seleccion, armada desde sus tramites. */
function itemOf(rows: readonly PayableRow[]): ProformaPaymentItem {
  const first = rows[0]!;
  const currency = first.proformaCurrency;
  const settled = sum(rows.map((r) => settledAmount(r.settlement, currency)), currency);
  const pending = sum(rows.map((r) => pendingAmount(r.settlement, currency)), currency);
  const total = sum(rows.map((r) => invoiceIn(r, currency) ?? 0), currency);
  return {
    proformaId: first.proformaId,
    number: first.proformaNumber === null ? '' : formatProformaNumber(first.proformaNumber),
    flow: first.proformaFlow,
    currency,
    shipmentCount: rows.length,
    total,
    settled,
    due: sum(rows.map((r) => dueOf(r, currency)), currency),
    inValidation: awaitsValidation(settled, pending, chargeBasisIn(currency, total)),
    approvedAt: first.approvedAt?.toISOString() ?? null,
  };
}

/** Agrupa las filas por proforma, conservando el orden. */
function byProforma(rows: readonly PayableRow[]): Map<string, PayableRow[]> {
  const map = new Map<string, PayableRow[]>();
  for (const row of rows) {
    const list = map.get(row.proformaId) ?? [];
    list.push(row);
    map.set(row.proformaId, list);
  }
  return map;
}

/** Lo que resulta de validar una seleccion de proformas para cobrar. */
interface Selection {
  clientId: string;
  clientCode: string;
  clientName: string;
  allowsCard: boolean;
  allowsBankDeposit: boolean;
  currency: Currency;
  flow: Flow;
  items: ProformaPaymentItem[];
  /** Los tramites con saldo abierto: a cada uno se le abona su saldo. */
  rows: PayableRow[];
  /** Todas las filas de las proformas elegidas (tambien las ya saldadas). */
  allRows: PayableRow[];
}

/**
 * Carga y valida las proformas elegidas (reglas 2 y 3 de la cabecera). Punto
 * UNICO de esa validacion: la cotizacion, el cobro del cliente y el registro del
 * staff pasan por aqui y no pueden aceptar conjuntos distintos.
 */
async function resolveSelection(clientId: string, proformaIds: readonly string[]): Promise<Selection> {
  const account = await paymentGroupsRepo.clientWithRate(clientId);
  if (!account) throw ShipmentErrors.notFound();

  const unique = [...new Set(proformaIds)];
  const allRows = await paymentGroupsRepo.payableRows(clientId, unique);
  const grouped = byProforma(allRows);
  for (const id of unique) {
    if (!grouped.has(id)) throw ProformaErrors.notFound();
  }

  for (const rows of grouped.values()) {
    const first = rows[0]!;
    if (first.proformaStatus !== ProformaStatus.Aprobada) {
      throw PaymentErrors.proformaNotPayable(
        first.proformaNumber === null ? null : formatProformaNumber(first.proformaNumber),
      );
    }
  }

  const currencies = new Set(allRows.map((r) => r.proformaCurrency));
  if (currencies.size > 1) throw PaymentErrors.mixedCurrencies();
  const currency = allRows[0]!.proformaCurrency;

  return {
    clientId: account.clientId,
    clientCode: account.clientCode,
    clientName: account.clientName,
    allowsCard: account.allowsCard ?? true,
    allowsBankDeposit: account.allowsBankDeposit ?? true,
    currency,
    flow: allRows[0]!.proformaFlow,
    items: [...grouped.values()].map(itemOf),
    rows: allRows.filter((r) => dueOf(r, currency) > 0),
    allRows,
  };
}

/** Saldo, confirmado y pendiente de la seleccion, en la moneda del cobro. */
function selectionTotals(selection: Selection) {
  const { currency, allRows } = selection;
  const invoice = sum(allRows.map((r) => invoiceIn(r, currency) ?? 0), currency);
  const settled = sum(allRows.map((r) => settledAmount(r.settlement, currency)), currency);
  const pending = sum(allRows.map((r) => pendingAmount(r.settlement, currency)), currency);
  const basis = chargeBasisIn(currency, allRows.length > 0 ? invoice : null);
  return {
    invoiceUsd: sum(allRows.map((r) => r.invoiceTotalUsd ?? 0), Currency.USD),
    invoiceCrc: sum(allRows.map((r) => r.invoiceTotalCrc ?? 0), Currency.CRC),
    settled,
    pending,
    basis,
    due: outstandingFor(settled, basis),
  };
}

/**
 * Tasa del COBRO: el cociente de las facturas de la seleccion, igual que en cada
 * abono; si no se puede, la global del sistema; quien la impone manda sobre las
 * dos. Null si no hay ninguna valida (la cotizacion no falla por eso: el deposito
 * no necesita tasa para ofrecerse).
 */
function groupExchangeRate(
  totals: { invoiceUsd: number; invoiceCrc: number },
  globalRate: number | null,
  forcedRate?: number,
): number | null {
  if (forcedRate != null) return forcedRate;
  const checked = exchangeRateSchema.safeParse(
    totals.invoiceUsd > 0 && totals.invoiceCrc > 0 ? totals.invoiceCrc / totals.invoiceUsd : globalRate,
  );
  return checked.success ? checked.data : null;
}

/** Medios de pago disponibles: los de la tarifa cruzados con lo que se puede cobrar hoy. */
function methodsFor(selection: Pick<Selection, 'allowsCard' | 'allowsBankDeposit'>): PaymentMethod[] {
  const methods: PaymentMethod[] = [];
  if (selection.allowsCard && isOnvoEnabled()) methods.push(PaymentMethod.Tarjeta);
  if (selection.allowsBankDeposit) methods.push(PaymentMethod.DepositoBancario);
  return methods;
}

/**
 * Suelta los cobros con tarjeta del casillero que quedaron abiertos y sin usar:
 * primero se le pide a la pasarela que cancele y solo si acepta se borra el
 * grupo. Si Onvo se niega, ese cargo va en camino y no se abre otro.
 */
async function discardOpenCardGroups(clientId: string): Promise<void> {
  for (const group of await paymentGroupsRepo.openCardGroups(clientId)) {
    if (group.gatewayReference && !(await onvoClient.cancelPaymentIntent(group.gatewayReference))) {
      throw PaymentErrors.cardAttemptInFlight();
    }
    await paymentGroupsRepo.removeGroup(group.id);
  }
}

export const proformaPaymentsService = {
  /** Proformas aprobadas (por cobrar) del casillero, para elegir cuales pagar. */
  async open(session: Session, requestedClientId?: string): Promise<ProformaPaymentItem[]> {
    const clientId = targetClientId(session, requestedClientId);
    return [...byProforma(await paymentGroupsRepo.openRows(clientId)).values()].map(itemOf);
  },

  /** Cotiza el cobro de las proformas elegidas. */
  async quote(
    session: Session,
    proformaIds: readonly string[],
    requestedClientId?: string,
  ): Promise<ProformaPaymentQuoteDto> {
    const selection = await resolveSelection(targetClientId(session, requestedClientId), proformaIds);
    const totals = selectionTotals(selection);
    const methods = methodsFor(selection);
    const [globalRate, surchargeRate] = await Promise.all([
      settingsRepo.currentExchangeRate(),
      settingsService.cardSurchargeRate(),
    ]);

    /**
     * EL COBRO CON TARJETA DESGLOSADO, con la MISMA funcion y la MISMA tasa que
     * `start`: la cifra que el cliente acepta es la que se le cobra.
     */
    const rate = groupExchangeRate(totals, globalRate);
    const cardCharge =
      methods.includes(PaymentMethod.Tarjeta) && rate != null && totals.due > 0
        ? cardChargeFor(totals.due, selection.currency, rate, surchargeRate)
        : null;

    return {
      clientId: selection.clientId,
      clientCode: selection.clientCode,
      clientName: selection.clientName,
      items: selection.items,
      chargeCurrency: selection.currency,
      due: totals.due,
      cardCharge,
      inValidation: awaitsValidation(totals.settled, totals.pending, totals.basis),
      availableMethods: methods,
      availableBankAccounts: bankAccountsFor(FLOW_SAMPLE_TYPE[selection.flow]),
    };
  },

  /**
   * El CLIENTE paga las proformas que eligio. Devuelve el grupo creado y, si es
   * con tarjeta, el intento de la pasarela para abrir el formulario.
   */
  async start(
    session: Session,
    input: StartProformaPaymentInput,
  ): Promise<{
    group: PaymentGroupDto;
    intent: Awaited<ReturnType<typeof onvoClient.createPaymentIntent>> | null;
  }> {
    const selection = await resolveSelection(targetClientId(session), input.proformaIds);
    const totals = selectionTotals(selection);
    if (selection.rows.length === 0) throw PaymentErrors.nothingToSettle();
    if (isSettled(selection.allRows.flatMap((r) => r.settlement), totals.basis)) {
      throw PaymentErrors.alreadySettled();
    }
    /**
     * UN SOLO COBRO ABIERTO POR SALDO: con un abono que ya cubre lo que falta y
     * sigue sin validar, no se admite otro. La peticion se puede repetir desde una
     * pestaña vieja, asi que no basta con esconder el boton.
     */
    if (awaitsValidation(totals.settled, totals.pending, totals.basis)) {
      throw PaymentErrors.inValidation();
    }

    // La tarifa manda sobre el medio de pago (decision 2 de payments.service).
    if (input.method === PaymentMethod.Tarjeta && !selection.allowsCard) {
      throw PaymentErrors.methodNotAllowed();
    }
    if (input.method === PaymentMethod.DepositoBancario && !selection.allowsBankDeposit) {
      throw PaymentErrors.methodNotAllowed();
    }
    if (
      input.method === PaymentMethod.DepositoBancario &&
      input.bankAccount &&
      !bankAccountsFor(FLOW_SAMPLE_TYPE[selection.flow]).includes(input.bankAccount)
    ) {
      throw PaymentErrors.bankAccountNotAllowed();
    }

    const isCard = input.method === PaymentMethod.Tarjeta;
    if (isCard) await discardOpenCardGroups(selection.clientId);

    const [globalRate, surchargeRate] = await Promise.all([
      settingsRepo.currentExchangeRate(),
      settingsService.cardSurchargeRate(),
    ]);

    /**
     * LA COMISION DE LA TARJETA, una sola sobre el total (un cargo por la tarjeta),
     * repartida entre los tramites en proporcion a su saldo sin perder ni
     * inventar un centimo (`splitAmount`): al confirmarse, la factura de cada
     * tramite sube por su parte y su abono la cubre.
     */
    const groupRate = groupExchangeRate(totals, globalRate);
    if (isCard && groupRate == null) throw PaymentErrors.exchangeRateUnavailable();
    const charge =
      isCard && groupRate != null
        ? cardChargeFor(totals.due, selection.currency, groupRate, surchargeRate)
        : null;
    const shares = charge
      ? splitAmount(charge.surcharge, selection.rows.map((r) => dueOf(r, selection.currency)), selection.currency)
      : [];
    const surchargeByShipment = new Map(selection.rows.map((r, i) => [r.id, shares[i] ?? 0] as const));

    const groupId = await this.createGroup({
      selection,
      method: input.method,
      globalRate,
      surchargeAmount: charge?.surcharge ?? 0,
      surchargeByShipment,
      // El deposito nace PENDIENTE (hay un comprobante que revisar) y la tarjeta
      // INICIADA (todavia no se ha intentado cobrar nada).
      status: isCard ? PaymentStatus.Iniciado : PaymentStatus.Pendiente,
      bankAccount: input.bankAccount ?? null,
      receiptNumber: input.receiptNumber ?? null,
      depositedAt: input.depositedAt ? new Date(input.depositedAt) : null,
      createdBy: session.userId,
    });

    let intent = null;
    if (isCard) {
      /**
       * Si la pasarela falla, el grupo recien creado se borra con sus abonos: ese
       * cobro nunca existio, y dejarlo mostraria abonos sin resolver que nadie
       * puede cerrar.
       */
      try {
        const numbers = selection.items.map((i) => i.number).join(', ');
        intent = await onvoClient.createPaymentIntent({
          // A la pasarela va el TOTAL: saldo mas comision.
          amount: charge?.total ?? totals.due,
          currency: selection.currency,
          paymentId: groupId,
          description: `Proformas ${numbers} (${selection.clientCode})`,
        });
      } catch (err) {
        await paymentGroupsRepo.removeGroup(groupId);
        throw err;
      }
      await paymentGroupsRepo.updateGroup(groupId, { gatewayReference: intent.reference });
    }

    return { group: await this.get(groupId), intent };
  },

  /**
   * El STAFF registra el deposito que el cliente ya hizo por unas proformas. Con
   * que situacion nace lo decide el PERMISO (`recordedPaymentStatus`): el
   * Operativo lo deja en validacion y el Administrador, confirmado.
   */
  async record(session: Session, input: RecordProformaPaymentInput): Promise<PaymentGroupDto> {
    const selection = await resolveSelection(input.clientId, input.proformaIds);
    if (selection.rows.length === 0) throw PaymentErrors.nothingToSettle();
    const totals = selectionTotals(selection);
    if (awaitsValidation(totals.settled, totals.pending, totals.basis)) {
      throw PaymentErrors.inValidation();
    }

    const status = recordedPaymentStatus(session.role);
    const confirmed = status === PaymentStatus.Confirmado;
    // La tasa es un valor general: quien no puede fijarla registra con la de la
    // factura de cada tramite (M5). Sin esta guarda el permiso seria cosmetico.
    const forced = canSetExchangeRate(session.role) ? input.exchangeRate : undefined;

    const groupId = await this.createGroup({
      selection,
      method: PaymentMethod.DepositoBancario,
      globalRate: forced ?? (await settingsRepo.currentExchangeRate()),
      forcedRate: forced,
      status,
      bankAccount: input.bankAccount,
      receiptNumber: input.receiptNumber,
      depositedAt: new Date(input.depositedAt),
      note: input.note ?? null,
      createdBy: session.userId,
      confirmedBy: confirmed ? session.userId : null,
      confirmedAt: confirmed ? new Date() : null,
    });

    if (confirmed) await proformaSettlement.syncForShipments(selection.rows.map((r) => r.id));
    return this.get(groupId);
  },

  /**
   * Arma el grupo y sus abonos. Punto UNICO de ese reparto: el cliente y el staff
   * entran por puertas distintas pero el dinero se distribuye igual.
   *
   * A CADA TRAMITE SU SALDO, sin prorratear: la suma de los abonos es exactamente
   * el saldo de las proformas porque cada uno es el saldo de su tramite.
   */
  async createGroup(args: {
    selection: Selection;
    method: PaymentMethod;
    globalRate: number | null;
    forcedRate?: number;
    surchargeAmount?: number;
    surchargeByShipment?: ReadonlyMap<string, number>;
    status: PaymentStatus;
    bankAccount?: BankAccount | null;
    receiptNumber?: string | null;
    depositedAt?: Date | null;
    note?: string | null;
    createdBy: string;
    confirmedBy?: string | null;
    confirmedAt?: Date | null;
  }): Promise<string> {
    const { selection } = args;
    const currency = selection.currency;
    const totals = selectionTotals(selection);
    const groupRate = groupExchangeRate(totals, args.globalRate, args.forcedRate);
    if (groupRate == null) throw PaymentErrors.exchangeRateUnavailable();

    return paymentGroupsRepo.insertGroupWithPayments(
      {
        clientId: selection.clientId,
        clientRateId: null,
        method: args.method,
        // El TOTAL que pasa por la tarjeta: saldo mas comision. Es la suma exacta
        // de los abonos que van debajo.
        amount: roundMoney(totals.due + (args.surchargeAmount ?? 0), currency),
        surchargeAmount: args.surchargeAmount ?? 0,
        currency,
        exchangeRate: groupRate,
        createdBy: args.createdBy,
      },
      (groupId) =>
        selection.rows.map((row) => ({
          shipmentId: row.id,
          groupId,
          method: args.method,
          status: args.status,
          amount: roundMoney(dueOf(row, currency) + (args.surchargeByShipment?.get(row.id) ?? 0), currency),
          surchargeAmount: args.surchargeByShipment?.get(row.id) ?? 0,
          currency,
          exchangeRate: args.forcedRate ?? rateFor(row, args.globalRate),
          bankAccount: args.bankAccount ?? null,
          receiptNumber: args.receiptNumber ?? null,
          depositedAt: args.depositedAt ?? null,
          note: args.note ?? null,
          createdBy: args.createdBy,
          confirmedBy: args.confirmedBy ?? null,
          confirmedAt: args.confirmedAt ?? null,
        })),
    );
  },

  /** Un grupo de cobro, con su situacion derivada de los abonos que lo componen. */
  async get(groupId: string): Promise<PaymentGroupDto> {
    const group = await paymentGroupsRepo.findGroup(groupId);
    if (!group) throw PaymentErrors.groupNotFound();

    const [lines, numbers] = await Promise.all([
      paymentGroupsRepo.groupPayments(groupId),
      paymentGroupsRepo.groupProformaNumbers(groupId),
    ]);
    return {
      id: group.id,
      clientId: group.clientId,
      clientCode: group.clientCode,
      clientName: group.clientName,
      method: group.method,
      status: paymentGroupStatus(lines.map((l) => l.status)),
      amount: group.amount,
      surchargeAmount: group.surchargeAmount,
      currency: group.currency,
      exchangeRate: group.exchangeRate,
      itemCount: lines.length,
      proformaNumbers: numbers.map(formatProformaNumber),
      createdAt: group.createdAt.toISOString(),
      createdByName: group.createdByName,
    };
  },

  /**
   * El navegador ya le mando la tarjeta a la pasarela: el cobro pasa a contar como
   * abono a la espera del webhook. Idempotente.
   */
  async markCardSubmitted(session: Session, groupId: string): Promise<PaymentGroupDto> {
    const group = await this.assertOwnGroup(session, groupId);
    if (group.method !== PaymentMethod.Tarjeta) throw PaymentErrors.methodNotAllowed();
    for (const line of await paymentGroupsRepo.groupPayments(groupId)) {
      await paymentsRepo.markSubmitted(line.id);
    }
    return this.get(groupId);
  },

  /**
   * El cliente cerro el formulario sin pagar. Se cancela el intento en la pasarela
   * y, SOLO si Onvo confirma la cancelacion, se suelta el grupo.
   */
  async abandonCard(session: Session, groupId: string): Promise<{ cancelled: boolean }> {
    const group = await this.assertOwnGroup(session, groupId);
    if (group.method !== PaymentMethod.Tarjeta) throw PaymentErrors.methodNotAllowed();

    const lines = await paymentGroupsRepo.groupPayments(groupId);
    if (!lines.every((l) => UNRESOLVED_PAYMENT_STATUSES.includes(l.status))) {
      throw PaymentErrors.alreadyResolved();
    }
    if (!group.gatewayReference) throw PaymentErrors.groupNotFound();
    if (!(await onvoClient.cancelPaymentIntent(group.gatewayReference))) return { cancelled: false };

    await paymentGroupsRepo.removeGroup(groupId);
    return { cancelled: true };
  },

  /**
   * Confirma o rechaza el cobro por orden de la PASARELA. Lo llama el webhook
   * cuando la referencia no corresponde a ningun abono suelto. Idempotente: cada
   * abono se resuelve con una sentencia condicionada (`resolveIfPending`).
   */
  async confirmByGateway(
    outcome: GatewayOutcome,
  ): Promise<{ applied: boolean; reason: 'ok' | 'unknown_reference' | 'already_resolved' }> {
    const group = await paymentGroupsRepo.findGroupByGatewayReference(outcome.reference);
    if (!group) return { applied: false, reason: 'unknown_reference' };

    const note = outcome.approved
      ? 'Cobro de proformas aprobado por la pasarela.'
      : `Cobro de proformas rechazado por la pasarela.${outcome.detail ? ` ${outcome.detail}` : ''}`;

    const lines = await paymentGroupsRepo.groupPayments(group.id);
    let applied = false;
    for (const line of lines) {
      const updated = await paymentsRepo.resolveIfPending(line.id, {
        status: outcome.approved ? PaymentStatus.Confirmado : PaymentStatus.Rechazado,
        note,
        confirmedAt: new Date(),
      });
      /**
       * La parte de la comision de este tramite se asienta y sube su factura. Se
       * intenta TAMBIEN cuando la fila ya estaba resuelta: el asiento pudo
       * quedarse sin hacer y el reintento del webhook es la oportunidad de
       * recuperarlo. Es idempotente.
       */
      if (outcome.approved && (updated || line.status === PaymentStatus.Confirmado)) {
        await costsService.postCardSurcharge(line);
      }
      if (updated) applied = true;
    }

    if (outcome.approved) await proformaSettlement.syncForShipments(lines.map((l) => l.shipmentId));
    return applied ? { applied: true, reason: 'ok' } : { applied: false, reason: 'already_resolved' };
  },

  /**
   * El ADMINISTRADOR confirma o rechaza un cobro entero de una vez (todos sus
   * abonos). Es lo que hace en la bandeja con un deposito por varias proformas:
   * validar abono por abono lo que fue un solo deposito no tiene sentido.
   */
  async resolveGroup(
    session: Session,
    groupId: string,
    input: ResolvePaymentGroupInput,
  ): Promise<PaymentGroupDto> {
    const lines = await paymentGroupsRepo.groupPayments(groupId);
    if (lines.length === 0) throw PaymentErrors.groupNotFound();
    if (!lines.every((l) => l.status === PaymentStatus.Pendiente)) throw PaymentErrors.alreadyResolved();

    for (const line of lines) {
      await paymentsRepo.update(line.id, {
        status: input.confirm ? PaymentStatus.Confirmado : PaymentStatus.Rechazado,
        ...(input.note ? { note: input.note } : {}),
        confirmedBy: session.userId,
        confirmedAt: new Date(),
      });
      // Un cobro con tarjeta que se quedo colgado y se resuelve a mano deja la
      // factura igual que si lo hubiera resuelto la pasarela.
      if (input.confirm) await costsService.postCardSurcharge(line);
    }

    if (input.confirm) await proformaSettlement.syncForShipments(lines.map((l) => l.shipmentId));
    return this.get(groupId);
  },

  /**
   * Flujo de PRUEBA: resuelve un cobro simulado sin pasar por Onvo. Tres
   * cerrojos: pasarela en modo simulado, referencia nacida simulada, grupo del
   * propio cliente.
   */
  async simulateGatewayOutcome(session: Session, groupId: string, approve: boolean): Promise<PaymentGroupDto> {
    if (!isOnvoSimulated()) throw PaymentErrors.simulationNotAllowed();
    const group = await this.assertOwnGroup(session, groupId);
    if (!group.gatewayReference || !onvoClient.isSimulatedReference(group.gatewayReference)) {
      throw PaymentErrors.simulationNotAllowed();
    }
    await this.confirmByGateway(onvoClient.simulateOutcome(group.gatewayReference, approve));
    return this.get(groupId);
  },

  /**
   * Comprobante del deposito. Se sube una vez y se adjunta a TODOS los abonos del
   * grupo: quien valida abre cualquiera y tiene que encontrar el respaldo. El
   * cliente solo mientras el cobro sigue pendiente; el staff tambien sobre uno ya
   * confirmado (el administrador lo registra confirmado y el archivo viaja despues).
   */
  async attachReceipt(session: Session, groupId: string, file: File): Promise<PaymentGroupDto> {
    await this.assertOwnGroup(session, groupId);

    const lines = await paymentGroupsRepo.groupPayments(groupId);
    const staff = session.role !== Role.Client;
    const open = lines.every(
      (l) => l.status === PaymentStatus.Pendiente || (staff && l.status === PaymentStatus.Confirmado),
    );
    if (lines.length === 0 || !open) throw PaymentErrors.alreadyResolved();

    const key = await storage.put('receipts', file);
    for (const line of lines) {
      const previous = await paymentsRepo.findById(line.id);
      if (previous?.receiptFileKey) await storage.remove(previous.receiptFileKey);
      await paymentsRepo.update(line.id, { receiptFileKey: key });
    }
    return this.get(groupId);
  },

  /** El grupo existe y es del casillero de la sesion (404 si no: no revela nada). */
  async assertOwnGroup(session: Session, groupId: string) {
    const group = await paymentGroupsRepo.findGroup(groupId);
    if (!group) throw PaymentErrors.groupNotFound();
    if (session.role === Role.Client && group.clientId !== session.clientId) {
      throw PaymentErrors.groupNotFound();
    }
    return group;
  },
};
