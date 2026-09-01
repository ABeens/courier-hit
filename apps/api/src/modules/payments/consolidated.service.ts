/**
 * PAGO AGRUPADO de una cuenta consolidada.
 *
 * Un casillero con tarifa `ClientRateKind.Consolidada` no paga paquete por
 * paquete: salda de una vez todos los que estan listos para facturar. Las reglas
 * del requisito, y donde se cumplen:
 *
 * 1. EL GRUPO NO SE ELIGE. Ni el cliente ni el staff mandan ids de tramite: el
 *    conjunto lo arma `consolidatedRepo.billableShipments` y entran TODOS. No hay
 *    parametro que permita excluir, quitar ni agregar uno, que es la unica forma
 *    de que "obligatoriamente todos" no dependa de la pantalla.
 * 2. EL COBRO CUBRE EL SALDO ENTERO. El importe lo pone el servidor sumando los
 *    saldos del grupo; no viaja en el cuerpo ni en el pago del cliente ni en el
 *    registro del staff.
 * 3. EL PAQUETE CONSOLIDADO NO SE PAGA SUELTO. La otra mitad de la regla vive en
 *    `payments.service` (`assertNotConsolidated`), que rechaza el pago individual
 *    de un tramite de esta cuenta. Sin ese cerrojo, "todos juntos" se rompe por
 *    el camino de al lado.
 *
 * COMO SE GUARDA. Una fila en `payment_groups` (el cobro) y un abono en
 * `payments` por cada paquete, apuntando al grupo. Cada abono lleva el saldo de
 * SU tramite, asi que la suma da el total exacto sin prorratear y todo lo que ya
 * pregunta "este paquete esta pagado" —`isSettled`, la guarda de salida a ruta,
 * el estatus de cobro del reporte— sigue respondiendo sin enterarse de que el
 * dinero entro junto.
 *
 * LA TASA (regla M5). Cada abono congela la de SU factura, igual que el pago
 * suelto, para que la aritmetica de cada tramite siga cuadrando. El grupo guarda
 * la del cobro completo (total en colones sobre total en dolares), que es la que
 * imprime la proforma consolidada.
 */
import {
  Currency,
  PaymentMethod,
  PaymentStatus,
  Role,
  UNRESOLVED_PAYMENT_STATUSES,
  awaitsValidation,
  bankAccountsFor,
  billsAsGroup,
  canSetExchangeRate,
  chargeBasisIn,
  chargeCurrencyFor,
  exchangeRateSchema,
  isSettled,
  outstanding,
  outstandingCrc,
  outstandingFor,
  paymentGroupStatus,
  pendingAmount,
  recordedPaymentStatus,
  roundMoney,
  settledAmount,
  ShipmentType,
} from '@courier/shared';
import type {
  BankAccount,
  ChargeBasis,
  ConsolidatedItem,
  ConsolidatedQuoteDto,
  PaymentGroupDto,
  RecordConsolidatedPaymentInput,
  Session,
  StartConsolidatedPaymentInput,
} from '@courier/shared';
import { PaymentErrors, ShipmentErrors } from '../../core/errors';
import { storage } from '../../core/storage';
import {
  isOnvoEnabled,
  isOnvoSimulated,
  onvoClient,
} from '../../integrations/onvo/onvo.client';
import type { GatewayOutcome } from '../../integrations/onvo/onvo.client';
import { settingsRepo } from '../settings/settings.repo';
import { consolidatedRepo } from './consolidated.repo';
import type { ConsolidatedCandidate } from './consolidated.repo';
import { paymentsRepo } from './payments.repo';

/**
 * Una cuenta consolidada con su grupo ya resuelto: quien es, con que tarifa y
 * que paquetes entran. Es lo que devuelven las dos puertas (cotizar y cobrar),
 * para que ninguna arme el conjunto por su cuenta.
 */
interface ResolvedAccount {
  clientId: string;
  clientCode: string;
  clientName: string;
  rateId: string | null;
  rateName: string;
  allowsCard: boolean;
  allowsBankDeposit: boolean;
  /** Los paquetes del grupo: listos para facturar y con saldo abierto. */
  items: ConsolidatedCandidate[];
}

/**
 * De que casillero se habla. El cliente solo alcanza el suyo; el staff indica
 * cual. Misma regla que `assertOwnership` en el pago suelto y por lo mismo: que
 * el alcance no dependa de que la pantalla mande el id correcto.
 */
function targetClientId(session: Session, requested?: string): string {
  if (session.role === Role.Client) {
    if (!session.clientId) throw ShipmentErrors.missingClientProfile();
    return session.clientId;
  }
  if (!requested) throw ShipmentErrors.notFound();
  return requested;
}

/**
 * Carga la cuenta y comprueba que sea consolidada.
 *
 * Los paquetes ya vienen filtrados a los que tienen SALDO ABIERTO: uno ya cubierto
 * no esta "listo para facturar", esta pagado, y meterlo en el grupo produciria un
 * abono de cero contra un tramite que nadie esta cobrando.
 */
async function resolveAccount(clientId: string): Promise<ResolvedAccount> {
  const account = await consolidatedRepo.clientWithRate(clientId);
  if (!account) throw ShipmentErrors.notFound();
  if (!account.rateKind || !billsAsGroup(account.rateKind)) throw PaymentErrors.notConsolidated();

  const candidates = await consolidatedRepo.billableShipments(clientId);
  // El saldo abierto se mide en la MONEDA DE COBRO, la misma con la que despues
  // se le abona: filtrar por la otra columna dejaria entrar al grupo un paquete
  // sin nada que cobrar, con un abono de cero encima.
  const items = candidates.filter((row) => dueOf(row) > 0);

  return {
    clientId: account.clientId,
    clientCode: account.clientCode,
    clientName: account.clientName,
    rateId: account.rateId,
    rateName: account.rateName ?? 'Consolidada',
    allowsCard: account.allowsCard ?? true,
    allowsBankDeposit: account.allowsBankDeposit ?? true,
    items,
  };
}

/**
 * MONEDA DE COBRO DEL GRUPO. Un grupo consolidado es siempre de paquetes, asi
 * que es la de la Paqueteria: dolares. Se deriva del tipo de tramite en vez de
 * escribirse a mano para que la regla siga viviendo en un solo sitio
 * (`chargeCurrencyFor`) y no haya que acordarse de este archivo si cambia.
 */
const CHARGE_CURRENCY = chargeCurrencyFor(ShipmentType.Paqueteria);

/**
 * De un par de cifras en las dos monedas, la que corresponde a la moneda de
 * cobro. Las sumas del grupo se calculan siempre en las dos (la pantalla del
 * staff lee colones), pero cobrar y liquidar toca una sola columna.
 */
function inCharge<T>(usd: T, crc: T): T {
  return CHARGE_CURRENCY === Currency.USD ? usd : crc;
}

/** Las cifras del grupo en las dos monedas, a partir de sus paquetes. */
function totalsOf(items: readonly ConsolidatedCandidate[]) {
  let invoiceUsd = 0;
  let invoiceCrc = 0;
  let settledUsd = 0;
  let settledCrc = 0;
  let pendingUsd = 0;
  let pendingCrc = 0;

  for (const row of items) {
    invoiceUsd += row.invoiceTotalUsd ?? 0;
    invoiceCrc += row.invoiceTotalCrc ?? 0;
    settledUsd += settledAmount(row.settlement, Currency.USD);
    settledCrc += settledAmount(row.settlement, Currency.CRC);
    pendingUsd += pendingAmount(row.settlement, Currency.USD);
    pendingCrc += pendingAmount(row.settlement, Currency.CRC);
  }

  return {
    invoiceTotalUsd: roundMoney(invoiceUsd, Currency.USD),
    invoiceTotalCrc: roundMoney(invoiceCrc, Currency.CRC),
    settledUsd: roundMoney(settledUsd, Currency.USD),
    settledCrc: roundMoney(settledCrc, Currency.CRC),
    pendingUsd: roundMoney(pendingUsd, Currency.USD),
    pendingCrc: roundMoney(pendingCrc, Currency.CRC),
  };
}

type GroupTotals = ReturnType<typeof totalsOf>;

/** El saldo de UN paquete del grupo, en colones. Es la cifra que lee el staff. */
function dueCrcOf(row: ConsolidatedCandidate): number {
  return outstandingCrc(settledAmount(row.settlement, Currency.CRC), row.invoiceTotalCrc);
}

/** La base con la que se liquida UN paquete del grupo. */
function basisOfRow(row: ConsolidatedCandidate): ChargeBasis {
  return chargeBasisIn(CHARGE_CURRENCY, inCharge(row.invoiceTotalUsd, row.invoiceTotalCrc));
}

/**
 * El saldo de UN paquete EN LA MONEDA DE COBRO: lo que se le va a abonar de
 * verdad. Es el importe que entra en la fila de `payments`, y su suma sobre
 * todos los paquetes es exactamente el total del grupo (ver `createGroup`).
 */
function dueOf(row: ConsolidatedCandidate): number {
  return outstandingFor(settledAmount(row.settlement, CHARGE_CURRENCY), basisOfRow(row));
}

/**
 * La base con la que se liquida EL GRUPO: la moneda de cobro y la suma de las
 * facturas en esa moneda.
 *
 * Sin paquetes queda en null y no en cero, por la misma razon que un tramite sin
 * factura: un total de cero se leeria como una cuenta ya saldada.
 */
function basisOf(items: readonly ConsolidatedCandidate[], totals: GroupTotals): ChargeBasis {
  return chargeBasisIn(
    CHARGE_CURRENCY,
    items.length > 0 ? inCharge(totals.invoiceTotalUsd, totals.invoiceTotalCrc) : null,
  );
}

/**
 * Tasa con la que se congela el abono de UN paquete (regla M5). Es la misma
 * fuente y el mismo orden que en el pago suelto (`invoiceExchangeRate`): primero
 * el cociente de la propia factura, que es el unico que deja la aritmetica del
 * tramite cuadrada, y solo si no existe la global del sistema.
 */
function rateFor(row: { invoiceTotalUsd: number | null; invoiceTotalCrc: number | null }, globalRate: number | null): number {
  const usd = row.invoiceTotalUsd ?? 0;
  const crc = row.invoiceTotalCrc ?? 0;
  const checked = exchangeRateSchema.safeParse(usd > 0 && crc > 0 ? crc / usd : globalRate);
  if (!checked.success) throw PaymentErrors.exchangeRateUnavailable();
  return checked.data;
}

/**
 * Suelta los cobros con tarjeta del casillero que quedaron abiertos y sin usar.
 * Mismo orden y misma razon que en el pago suelto: primero se le pide a la
 * pasarela que cancele y solo si acepta se borra el grupo. Si Onvo se niega, ese
 * cargo va en camino y no se abre otro formulario.
 */
async function discardOpenCardGroups(clientId: string): Promise<void> {
  for (const group of await consolidatedRepo.openCardGroups(clientId)) {
    if (
      group.gatewayReference &&
      !(await onvoClient.cancelPaymentIntent(group.gatewayReference))
    ) {
      throw PaymentErrors.cardAttemptInFlight();
    }
    await consolidatedRepo.removeGroup(group.id);
  }
}

/** Medios de pago disponibles: los de la tarifa cruzados con lo que se puede cobrar hoy. */
function methodsFor(account: ResolvedAccount): PaymentMethod[] {
  const methods: PaymentMethod[] = [];
  if (account.allowsCard && isOnvoEnabled()) methods.push(PaymentMethod.Tarjeta);
  if (account.allowsBankDeposit) methods.push(PaymentMethod.DepositoBancario);
  return methods;
}

export const consolidatedService = {
  /**
   * Lo que la pantalla de pago agrupado necesita: los paquetes que entran (todos,
   * sin eleccion posible), cuanto suman y con que se puede pagar.
   */
  async quote(session: Session, requestedClientId?: string): Promise<ConsolidatedQuoteDto> {
    const clientId = targetClientId(session, requestedClientId);

    /**
     * Una cuenta corriente NO es un error aqui: la pantalla esta preguntando si
     * este casillero se cobra agrupado, y "no" es una respuesta. Se devuelve el
     * sobre vacio con `consolidated: false` para que la web no tenga que leer un
     * 409 como si fuera un dato. Cobrar sobre una cuenta asi si falla (`start`).
     */
    const base = await consolidatedRepo.clientWithRate(clientId);
    if (!base) throw ShipmentErrors.notFound();
    if (!base.rateKind || !billsAsGroup(base.rateKind)) {
      return {
        consolidated: false,
        clientId: base.clientId,
        clientCode: base.clientCode,
        clientName: base.clientName,
        rateName: base.rateName ?? '',
        items: [],
        invoiceTotalUsd: null,
        invoiceTotalCrc: null,
        settledUsd: 0,
        settledCrc: 0,
        pendingUsd: 0,
        pendingCrc: 0,
        dueCrc: 0,
        chargeCurrency: CHARGE_CURRENCY,
        due: 0,
        settled: false,
        inValidation: false,
        availableMethods: [],
        availableBankAccounts: [],
      };
    }

    const account = await resolveAccount(clientId);
    const totals = totalsOf(account.items);

    const items: ConsolidatedItem[] = account.items.map((row) => ({
      shipmentId: row.id,
      code: row.code,
      tracking: row.tracking,
      description: row.description,
      weightKg: row.weightKg,
      invoiceTotalUsd: row.invoiceTotalUsd,
      invoiceTotalCrc: row.invoiceTotalCrc,
      settledUsd: settledAmount(row.settlement, Currency.USD),
      settledCrc: settledAmount(row.settlement, Currency.CRC),
      dueUsd: outstanding(
        settledAmount(row.settlement, Currency.USD),
        row.invoiceTotalUsd,
        Currency.USD,
      ),
      dueCrc: dueCrcOf(row),
    }));

    const settledPayments = account.items.flatMap((row) => row.settlement);
    const invoiceCrc = account.items.length > 0 ? totals.invoiceTotalCrc : null;

    /** La base del cobro del grupo: moneda y total facturado en ella. */
    const basis = basisOf(account.items, totals);
    const settledInCharge = inCharge(totals.settledUsd, totals.settledCrc);
    const pendingInCharge = inCharge(totals.pendingUsd, totals.pendingCrc);

    return {
      consolidated: true,
      clientId: account.clientId,
      clientCode: account.clientCode,
      clientName: account.clientName,
      rateName: account.rateName,
      items,
      invoiceTotalUsd: account.items.length > 0 ? totals.invoiceTotalUsd : null,
      invoiceTotalCrc: invoiceCrc,
      settledUsd: totals.settledUsd,
      settledCrc: totals.settledCrc,
      pendingUsd: totals.pendingUsd,
      pendingCrc: totals.pendingCrc,
      dueCrc: outstandingCrc(totals.settledCrc, invoiceCrc),
      chargeCurrency: basis.currency,
      due: outstandingFor(settledInCharge, basis),
      settled: isSettled(settledPayments, basis),
      inValidation: awaitsValidation(settledInCharge, pendingInCharge, basis),
      availableMethods: methodsFor(account),
      /**
       * Las cuentas de la Paqueteria: solo las de dolares. Un grupo consolidado es
       * siempre de paquetes, asi que la lista es la misma que le tocaria a
       * cualquiera de ellos por separado, y sale de la misma funcion.
       */
      availableBankAccounts: bankAccountsFor(ShipmentType.Paqueteria),
    };
  },

  /**
   * El CLIENTE paga su cuenta consolidada. Devuelve el grupo creado y, si es con
   * tarjeta, el intento de la pasarela para abrir el formulario.
   */
  async start(
    session: Session,
    input: StartConsolidatedPaymentInput,
  ): Promise<{
    group: PaymentGroupDto;
    intent: Awaited<ReturnType<typeof onvoClient.createPaymentIntent>> | null;
  }> {
    const account = await resolveAccount(targetClientId(session));
    if (account.items.length === 0) throw PaymentErrors.nothingToSettle();

    const totals = totalsOf(account.items);
    const basis = basisOf(account.items, totals);
    if (isSettled(account.items.flatMap((r) => r.settlement), basis)) {
      throw PaymentErrors.alreadySettled();
    }

    /**
     * UN SOLO COBRO ABIERTO POR SALDO, igual que en el pago suelto: con un abono
     * que ya cubre lo que falta y sigue sin validar, la cuenta no admite otro. La
     * peticion se puede repetir desde una pestaña vieja o a mano, asi que no basta
     * con que la pantalla esconda el boton.
     */
    if (
      awaitsValidation(
        inCharge(totals.settledUsd, totals.settledCrc),
        inCharge(totals.pendingUsd, totals.pendingCrc),
        basis,
      )
    ) {
      throw PaymentErrors.inValidation();
    }

    // La tarifa manda sobre el medio de pago, como en el cobro individual.
    if (input.method === PaymentMethod.Tarjeta && !account.allowsCard) {
      throw PaymentErrors.methodNotAllowed();
    }
    if (input.method === PaymentMethod.DepositoBancario && !account.allowsBankDeposit) {
      throw PaymentErrors.methodNotAllowed();
    }
    if (
      input.method === PaymentMethod.DepositoBancario &&
      input.bankAccount &&
      !bankAccountsFor(ShipmentType.Paqueteria).includes(input.bankAccount)
    ) {
      throw PaymentErrors.bankAccountNotAllowed();
    }

    const isCard = input.method === PaymentMethod.Tarjeta;
    if (isCard) await discardOpenCardGroups(account.clientId);

    const globalRate = await settingsRepo.currentExchangeRate();
    const groupId = await this.createGroup({
      account,
      method: input.method,
      globalRate,
      /**
       * El deposito nace PENDIENTE (hay un comprobante que revisar) y la tarjeta
       * INICIADA (todavia no se ha intentado cobrar nada). Es la misma regla del
       * pago suelto, y por eso el grupo entero comparte situacion: se cobro en un
       * solo movimiento.
       */
      status: isCard ? PaymentStatus.Iniciado : PaymentStatus.Pendiente,
      bankAccount: input.bankAccount ?? null,
      receiptNumber: input.receiptNumber ?? null,
      depositedAt: input.depositedAt ? new Date(input.depositedAt) : null,
      createdBy: session.userId,
    });

    let intent = null;
    if (isCard) {
      /**
       * Si la pasarela falla, el grupo recien creado se borra con sus abonos.
       * Dejarlo seria peor que no haberlo creado: nace pendiente, asi que la
       * bandeja del staff mostraria varios depositos por validar que nadie puede
       * resolver y sin comprobante. Ese cobro nunca existio.
       */
      try {
        intent = await onvoClient.createPaymentIntent({
          amount: outstandingFor(inCharge(totals.settledUsd, totals.settledCrc), basis),
          currency: basis.currency,
          paymentId: groupId,
          description: `Consolidado ${account.clientCode} — ${account.items.length} paquetes`,
        });
      } catch (err) {
        await consolidatedRepo.removeGroup(groupId);
        throw err;
      }
      await consolidatedRepo.updateGroup(groupId, { gatewayReference: intent.reference });
    }

    return { group: await this.get(groupId), intent };
  },

  /**
   * El STAFF registra el deposito agrupado que el cliente ya hizo.
   *
   * Con que situacion nace lo decide el PERMISO y no el cuerpo
   * (`recordedPaymentStatus`), igual que en el registro suelto: el Operativo lo
   * deja en validacion y el Administrador, que ademas puede aprobarlo, confirmado.
   */
  async record(
    session: Session,
    input: RecordConsolidatedPaymentInput,
  ): Promise<PaymentGroupDto> {
    const account = await resolveAccount(input.clientId);
    if (account.items.length === 0) throw PaymentErrors.nothingToSettle();

    const status = recordedPaymentStatus(session.role);
    const confirmed = status === PaymentStatus.Confirmado;

    /**
     * La tasa es un valor general del sistema: quien no puede fijarla registra con
     * la de la factura de cada paquete, que es ademas la que cuadra el abono con
     * lo cobrado. Sin esta guarda el permiso seria cosmetico.
     */
    const forced = canSetExchangeRate(session.role) ? input.exchangeRate : undefined;

    const groupId = await this.createGroup({
      account,
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

    return this.get(groupId);
  },

  /**
   * Arma el grupo y sus abonos. Punto UNICO de ese reparto: el cliente y el staff
   * entran por puertas distintas pero el dinero se distribuye igual, y con la
   * cuenta escrita dos veces acabarian repartiendolo distinto.
   *
   * A CADA PAQUETE SU SALDO, sin prorratear. La suma de los abonos es exactamente
   * el total del grupo porque cada uno es el saldo de su tramite; repartir el
   * total entre N habria dejado a alguno con un colon de mas o de menos y con el
   * paquete sin saldar por ese colon.
   */
  async createGroup(args: {
    account: ResolvedAccount;
    method: PaymentMethod;
    globalRate: number | null;
    /** Tasa impuesta por quien la puede fijar; sin ella manda la de cada factura. */
    forcedRate?: number;
    status: PaymentStatus;
    bankAccount?: BankAccount | null;
    receiptNumber?: string | null;
    depositedAt?: Date | null;
    note?: string | null;
    createdBy: string;
    confirmedBy?: string | null;
    confirmedAt?: Date | null;
  }): Promise<string> {
    const totals = totalsOf(args.account.items);
    const groupAmount = outstandingFor(
      inCharge(totals.settledUsd, totals.settledCrc),
      basisOf(args.account.items, totals),
    );

    /**
     * Tasa del GRUPO: el cociente del cobro completo, que es la que imprime la
     * proforma consolidada. Se valida con el mismo esquema que la de cada abono
     * (regla M5): una tasa que impone el servidor no entra por una puerta con
     * menos validacion que la que digita una persona.
     */
    const groupRate =
      args.forcedRate ??
      (() => {
        const checked = exchangeRateSchema.safeParse(
          totals.invoiceTotalUsd > 0 && totals.invoiceTotalCrc > 0
            ? totals.invoiceTotalCrc / totals.invoiceTotalUsd
            : args.globalRate,
        );
        if (!checked.success) throw PaymentErrors.exchangeRateUnavailable();
        return checked.data;
      })();

    return consolidatedRepo.insertGroupWithPayments(
      {
        clientId: args.account.clientId,
        clientRateId: args.account.rateId,
        method: args.method,
        amount: groupAmount,
        currency: CHARGE_CURRENCY,
        exchangeRate: groupRate,
        createdBy: args.createdBy,
      },
      (groupId) =>
        args.account.items.map((row) => ({
          shipmentId: row.id,
          groupId,
          method: args.method,
          status: args.status,
          amount: dueOf(row),
          currency: CHARGE_CURRENCY,
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
    const group = await consolidatedRepo.findGroup(groupId);
    if (!group) throw PaymentErrors.groupNotFound();

    const lines = await consolidatedRepo.groupPayments(groupId);
    return {
      id: group.id,
      clientId: group.clientId,
      clientCode: group.clientCode,
      clientName: group.clientName,
      method: group.method,
      status: paymentGroupStatus(lines.map((l) => l.status)),
      amount: group.amount,
      currency: group.currency,
      exchangeRate: group.exchangeRate,
      itemCount: lines.length,
      createdAt: group.createdAt.toISOString(),
      createdByName: group.createdByName,
    };
  },

  /**
   * El navegador ya le mando la tarjeta a la pasarela: el cobro deja de ser un
   * formulario abierto y pasa a contar como abono a la espera del webhook. No
   * confirma nada (eso es del webhook) y es idempotente: si el desenlace ya llego,
   * no toca nada.
   */
  async markCardSubmitted(session: Session, groupId: string): Promise<PaymentGroupDto> {
    const group = await this.assertOwnGroup(session, groupId);
    if (group.method !== PaymentMethod.Tarjeta) throw PaymentErrors.methodNotAllowed();

    for (const line of await consolidatedRepo.groupPayments(groupId)) {
      await paymentsRepo.markSubmitted(line.id);
    }
    return this.get(groupId);
  },

  /**
   * El cliente cerro el formulario sin pagar. Se cancela el intento en la pasarela
   * y, SOLO si Onvo confirma la cancelacion, se suelta el grupo. Al reves habria
   * una ventana en la que borramos el cobro y el cargo sale igual: el webhook
   * llegaria sin nada que tocar y el cliente habria pagado sin rastro.
   */
  async abandonCard(session: Session, groupId: string): Promise<{ cancelled: boolean }> {
    const group = await this.assertOwnGroup(session, groupId);
    if (group.method !== PaymentMethod.Tarjeta) throw PaymentErrors.methodNotAllowed();

    const lines = await consolidatedRepo.groupPayments(groupId);
    if (!lines.every((l) => UNRESOLVED_PAYMENT_STATUSES.includes(l.status))) {
      throw PaymentErrors.alreadyResolved();
    }
    if (!group.gatewayReference) throw PaymentErrors.groupNotFound();

    if (!(await onvoClient.cancelPaymentIntent(group.gatewayReference))) {
      return { cancelled: false };
    }

    await consolidatedRepo.removeGroup(groupId);
    return { cancelled: true };
  },

  /**
   * Confirma o rechaza el cobro agrupado por orden de la PASARELA. Lo llama el
   * webhook cuando la referencia no corresponde a ningun abono suelto.
   *
   * Resuelve TODOS los abonos del grupo con la misma sentencia condicionada que el
   * pago individual (`resolveIfPending`), asi que un reintento de Onvo no aplica
   * nada dos veces: la segunda pasada no encuentra filas por resolver.
   */
  async confirmByGateway(
    outcome: GatewayOutcome,
  ): Promise<{ applied: boolean; reason: 'ok' | 'unknown_reference' | 'already_resolved' }> {
    const group = await consolidatedRepo.findGroupByGatewayReference(outcome.reference);
    if (!group) return { applied: false, reason: 'unknown_reference' };

    const note = outcome.approved
      ? 'Cobro consolidado aprobado por la pasarela.'
      : `Cobro consolidado rechazado por la pasarela.${outcome.detail ? ` ${outcome.detail}` : ''}`;

    let applied = false;
    for (const line of await consolidatedRepo.groupPayments(group.id)) {
      const updated = await paymentsRepo.resolveIfPending(line.id, {
        status: outcome.approved ? PaymentStatus.Confirmado : PaymentStatus.Rechazado,
        note,
        confirmedAt: new Date(),
      });
      if (updated) applied = true;
    }

    return applied ? { applied: true, reason: 'ok' } : { applied: false, reason: 'already_resolved' };
  },

  /**
   * Flujo de PRUEBA: resuelve un cobro agrupado simulado sin pasar por Onvo. Los
   * mismos tres cerrojos que en el pago suelto (pasarela en modo simulado,
   * referencia nacida simulada, grupo del propio cliente).
   */
  async simulateGatewayOutcome(
    session: Session,
    groupId: string,
    approve: boolean,
  ): Promise<PaymentGroupDto> {
    if (!isOnvoSimulated()) throw PaymentErrors.simulationNotAllowed();

    const group = await this.assertOwnGroup(session, groupId);
    if (!group.gatewayReference || !onvoClient.isSimulatedReference(group.gatewayReference)) {
      throw PaymentErrors.simulationNotAllowed();
    }

    await this.confirmByGateway(onvoClient.simulateOutcome(group.gatewayReference, approve));
    return this.get(groupId);
  },

  /**
   * Comprobante del deposito AGRUPADO. Se sube una vez y se adjunta a TODOS los
   * abonos del grupo.
   *
   * El mismo archivo en las cinco filas y no en una "principal": quien valida
   * abre un abono cualquiera y tiene que encontrar el respaldo, y el comprobante
   * de un deposito unico respalda a los cinco por igual. El archivo se guarda una
   * sola vez en el almacen; lo que se repite es la clave.
   *
   * La ventana es la misma que en el pago suelto (`attachReceipt`): el cliente
   * solo mientras el cobro sigue PENDIENTE; el staff tambien sobre uno ya
   * confirmado, porque el administrador lo registra confirmado de un golpe y el
   * archivo viaja en una segunda peticion.
   */
  async attachReceipt(session: Session, groupId: string, file: File): Promise<PaymentGroupDto> {
    await this.assertOwnGroup(session, groupId);

    const lines = await consolidatedRepo.groupPayments(groupId);
    const staff = session.role !== Role.Client;
    const open = lines.every(
      (l) =>
        l.status === PaymentStatus.Pendiente ||
        (staff && l.status === PaymentStatus.Confirmado),
    );
    if (lines.length === 0 || !open) throw PaymentErrors.alreadyResolved();

    const key = await storage.put('receipts', file);
    for (const line of lines) {
      const previous = await paymentsRepo.findById(line.id);
      // Reemplazar el comprobante borra el anterior: dejarlo huerfano solo acumula
      // basura que ya nadie puede alcanzar.
      if (previous?.receiptFileKey) await storage.remove(previous.receiptFileKey);
      await paymentsRepo.update(line.id, { receiptFileKey: key });
    }

    return this.get(groupId);
  },

  /** El grupo existe y es del casillero de la sesion (404 si no: no revela nada). */
  async assertOwnGroup(session: Session, groupId: string) {
    const group = await consolidatedRepo.findGroup(groupId);
    if (!group) throw PaymentErrors.groupNotFound();
    if (session.role === Role.Client && group.clientId !== session.clientId) {
      throw PaymentErrors.groupNotFound();
    }
    return group;
  },
};
