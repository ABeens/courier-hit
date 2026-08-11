/**
 * Pago de un tramite. Fuente: "Requerimientos Parte 2 - Portal Cliente" L83-90
 * (el cliente paga desde el portal) y "Parte 3 - Portal Administrador" L84-88
 * (el administrador registra la Informacion de Pago de un tramite manual).
 *
 * Los dos requerimientos describen el MISMO hecho desde dos lados del mostrador:
 * alguien abona un monto contra un tramite y ese abono queda registrado. Por eso
 * hay una sola entidad y no dos tablas paralelas; lo que cambia es quien la crea
 * y por que via (`PaymentMethod`).
 *
 * Tres decisiones que viven aqui:
 *
 * 1. EL PAGO ES UN MONTO TRANSACCIONAL. Lleva moneda explicita (regla M2) y tasa
 *    de cambio capturada al guardar (regla M5), igual que una linea de costo: es
 *    el punto donde una cifra concreta se aplica a un tramite concreto.
 * 2. EL DEPOSITO NACE PENDIENTE. Subir un comprobante no es cobrar: el staff lo
 *    valida (permiso payments.validate) y solo entonces pasa a Confirmado. La
 *    tarjeta, en cambio, la confirma la pasarela.
 * 3. "PAGADO" NO ES UN ESTADO DEL TRAMITE. El manual lo deja abierto ("valorar si
 *    ocupamos un estado para el paquete pagado"): se resuelve derivandolo de los
 *    pagos confirmados (`isSettled`) en vez de agregar un estado a las tres
 *    maquinas. Asi Condition.RequiresConfirmedPayment tiene una respuesta unica.
 */
import { Currency, convertMoney, roundMoney, smallestUnit } from '../money/currency';
import { Role } from '../auth/roles';
import { Flow, ShipmentType, flowForType } from '../workflow/shipment-type';

/** Via por la que entro el dinero (docs: "2 maneras de Pago: Tarjeta y Por depósito bancario"). */
export enum PaymentMethod {
  Tarjeta = 'tarjeta',
  DepositoBancario = 'deposito_bancario',
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  [PaymentMethod.Tarjeta]: 'Tarjeta de crédito',
  [PaymentMethod.DepositoBancario]: 'Depósito bancario',
};

/** Situacion del abono. Solo `Confirmado` cuenta como dinero recibido. */
export enum PaymentStatus {
  /** Comprobante subido, a la espera de que el staff lo valide. */
  Pendiente = 'pendiente',
  Confirmado = 'confirmado',
  Rechazado = 'rechazado',
}

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  [PaymentStatus.Pendiente]: 'Pendiente de validación',
  [PaymentStatus.Confirmado]: 'Confirmado',
  [PaymentStatus.Rechazado]: 'Rechazado',
};

/**
 * Cuentas bancarias donde HS Global recibe depositos (docs/manuales/flujo.md L85:
 * "Cuenta (BAC, BCR)").
 *
 * UNA ENTRADA POR CUENTA REAL, no por banco. Cada banco tiene dos cuentas
 * distintas, una por moneda, con numeros distintos: elegir "BCR" no dice a donde
 * se deposito. Y el numero es justamente lo que el cliente necesita ver para
 * poder depositar, que es el hueco que este modulo tenia abierto.
 *
 * Valores de dominio, estables: alimentan un enum de Postgres.
 */
export enum BankAccount {
  BacUsd = 'bac_usd',
  BacCrc = 'bac_crc',
  BcrUsd = 'bcr_usd',
  BcrCrc = 'bcr_crc',
}

/** Los datos que el cliente necesita para poder depositar. */
export interface BankAccountInfo {
  /** Nombre del banco tal como lo conoce el cliente. */
  bank: string;
  /** Moneda de la cuenta. NO es la moneda del abono: es la de la cuenta. */
  currency: Currency;
  /** Numero de cuenta cliente. Null en las cuentas que solo se operan por IBAN. */
  number: string | null;
  /** Cuenta IBAN, la que sirve para transferencias entre bancos. */
  iban: string;
}

/**
 * Catalogo de las cuentas de HS Global. Vive en el codigo y no en la BD a
 * proposito: son cuatro cuentas propias de la empresa que cambian cada varios
 * años, no un dato que el administrador mantenga. Si algun dia hay que
 * editarlas desde la pantalla de configuracion, este es el unico lugar del que
 * salen y mover la fuente no rompe a quien las consume.
 */
export const BANK_ACCOUNTS: Record<BankAccount, BankAccountInfo> = {
  [BankAccount.BacUsd]: {
    bank: 'BAC San José',
    currency: Currency.USD,
    number: '954526463',
    iban: 'CR45010200009545264633',
  },
  [BankAccount.BacCrc]: {
    bank: 'BAC San José',
    currency: Currency.CRC,
    number: '954526471',
    iban: 'CR35010200009545264716',
  },
  [BankAccount.BcrUsd]: {
    bank: 'BCR',
    currency: Currency.USD,
    number: null,
    iban: 'CR96015201001050225764',
  },
  [BankAccount.BcrCrc]: {
    bank: 'BCR',
    currency: Currency.CRC,
    number: null,
    iban: 'CR09015201001050225681',
  },
};

/** Como se nombra una moneda al hablar de la cuenta ("cuenta en dólares"). */
const ACCOUNT_CURRENCY_WORD: Record<Currency, string> = {
  [Currency.USD]: 'dólares',
  [Currency.CRC]: 'colones',
};

/**
 * Etiqueta corta que IDENTIFICA la cuenta: banco y moneda. Es lo que va en el
 * reporte y en las fichas, donde el numero completo solo estorba.
 */
export const BANK_ACCOUNT_LABELS: Record<BankAccount, string> = Object.fromEntries(
  Object.entries(BANK_ACCOUNTS).map(([key, info]) => [
    key,
    `${info.bank}, ${ACCOUNT_CURRENCY_WORD[info.currency]}`,
  ]),
) as Record<BankAccount, string>;

/**
 * Etiqueta para ELEGIR la cuenta: la identifica y ademas trae el numero, porque
 * quien abre ese select lo que va a hacer es copiarlo para depositar. Se prefiere
 * el numero de cuenta cliente cuando existe (es el que se digita en la ventanilla
 * del propio banco) y se cae al IBAN cuando no.
 */
export function bankAccountOptionLabel(account: BankAccount): string {
  const info = BANK_ACCOUNTS[account];
  return `${BANK_ACCOUNT_LABELS[account]} · ${info.number ?? info.iban}`;
}

/**
 * Cuentas que se le OFRECEN al cliente para depositar un tramite: Paqueteria
 * solo las de dolares, Transporte y Agenciamiento las de las dos monedas.
 *
 * No es una regla suelta: es la misma con la que `billingCurrencyFor` le cobra
 * la Paqueteria al cliente en dolares. Ofrecerle una cuenta en colones para una
 * factura que lee en dolares es pedirle que convierta el monto de cabeza, y el
 * comprobante llega por una cifra que no cuadra con nada.
 *
 * Solo acota lo que se le PROPONE. La cuenta a la que realmente entro el dinero
 * la sabe el banco, no el sistema: por eso el staff puede corregirla despues sin
 * este filtro (ver `bankAccountsForStaff`).
 */
export function bankAccountsFor(shipmentType: ShipmentType): BankAccount[] {
  const accounts = Object.values(BankAccount);
  if (flowForType(shipmentType) !== Flow.Paqueteria) return accounts;
  return accounts.filter((a) => BANK_ACCOUNTS[a].currency === Currency.USD);
}

/**
 * Cuentas entre las que puede elegir el STAFF al registrar o corregir un
 * deposito: TODAS, sin el filtro por tipo de tramite.
 *
 * El requerimiento lo pide explicito ("un operario o administrador luego puede
 * indicar que se deposito a otro tipo de cuenta"). El filtro de arriba es una
 * ayuda para que el cliente deposite donde corresponde; una vez que el dinero
 * entro, negarle al operario la cuenta que el estado de cuenta dice seria
 * obligarlo a registrar un dato falso.
 */
export function bankAccountsForStaff(): BankAccount[] {
  return Object.values(BankAccount);
}

/** Pago tal como lo devuelve la API. */
export interface PaymentDto {
  id: string;
  shipmentId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  /** Monto abonado. Siempre >= 0 (regla M3). */
  amount: number;
  /** Moneda del monto, explicita (regla M2). */
  currency: Currency;
  /** Colones por 1 USD al momento de registrar el pago (regla M5). Siempre > 0. */
  exchangeRate: number;

  // --- Solo deposito bancario (la "Informacion de Pago" del manual) ---
  bankAccount: BankAccount | null;
  /** Num. Comprobante de Deposito. */
  receiptNumber: string | null;
  /** Fecha de Deposito: instante en UTC, ISO 8601. */
  depositedAt: string | null;
  /** Clave del comprobante subido en el almacen de archivos; null si no se adjunto. */
  receiptFileKey: string | null;

  // --- Solo tarjeta ---
  /** Referencia que devuelve la pasarela. Null mientras no este integrada. */
  gatewayReference: string | null;

  note: string | null;
  createdByName: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

/** Datos minimos para totalizar un pago (la fila de BD y el DTO los cumplen). */
type Settleable = Pick<PaymentDto, 'amount' | 'currency' | 'exchangeRate' | 'status'>;

/**
 * Suma de los pagos CONFIRMADOS en la moneda pedida. Cada pago se convierte con
 * SU propia tasa, igual que `computeTotals` con las lineas de costo: un tramite
 * abonado en dos dias distintos sigue cuadrando.
 */
export function settledAmount(payments: readonly Settleable[], target: Currency): number {
  return sumByStatus(payments, target, PaymentStatus.Confirmado);
}

/**
 * Suma de los pagos EN VALIDACION (subidos por el cliente, sin resolver todavia).
 *
 * NO es dinero recibido y no cuenta para `isSettled`: eso lo decide `settledAmount`
 * y nada mas. Existe para lo que la pantalla necesita decirle al cliente, que es
 * otra pregunta: "tu comprobante llego y lo estamos revisando". Sin esto, quien
 * acaba de subir un deposito ve el saldo intacto y un boton de pagar, y paga dos
 * veces por el mismo tramite.
 */
export function pendingAmount(payments: readonly Settleable[], target: Currency): number {
  return sumByStatus(payments, target, PaymentStatus.Pendiente);
}

/** Suma en `target` de los pagos en una situacion dada. Punto unico de la conversion. */
function sumByStatus(
  payments: readonly Settleable[],
  target: Currency,
  status: PaymentStatus,
): number {
  const total = payments
    .filter((p) => p.status === status)
    .reduce((sum, p) => sum + convertMoney(p.amount, p.currency, target, p.exchangeRate), 0);
  return roundMoney(total, target);
}

/**
 * True si el tramite ya esta cubierto: lo confirmado alcanza el monto de factura.
 * Es la respuesta UNICA a Condition.RequiresConfirmedPayment; nadie mas decide
 * si un tramite esta pagado.
 *
 * Se compara en colones porque es la moneda de cobro local y la que no tiene
 * centimos: evita que un redondeo de centavos deje una deuda de $0.01 abierta.
 * Sin monto de factura no hay nada que cubrir todavia -> false.
 */
export function isSettled(
  payments: readonly Settleable[],
  invoiceTotalCrc: number | null,
): boolean {
  if (invoiceTotalCrc == null) return false;
  return settledAmount(payments, Currency.CRC) >= invoiceTotalCrc;
}

/**
 * Saldo pendiente en colones: lo facturado menos lo ya abonado, nunca negativo
 * (un sobrepago no genera deuda a favor del cliente).
 *
 * Punto UNICO de esa resta. La cotizacion que ve el cliente al pagar, el importe
 * que se le cobra a la tarjeta y la bandera que ve el operador en la ficha del
 * tramite tienen que dar la misma cifra; con la resta escrita en tres lados,
 * tarde o temprano no la dan.
 *
 * Sin monto de factura todavia no hay nada que cobrar -> 0.
 */
export function outstandingCrc(settledCrc: number, invoiceTotalCrc: number | null): number {
  return outstanding(settledCrc, invoiceTotalCrc, Currency.CRC);
}

/**
 * La misma resta en la moneda pedida. Existe porque el saldo se COBRA en colones
 * pero no siempre se MUESTRA en colones (ver `billingCurrencyFor`), y las dos
 * cifras tienen que salir de la misma formula.
 */
export function outstanding(
  settled: number,
  invoiceTotal: number | null,
  currency: Currency,
): number {
  if (invoiceTotal == null) return 0;
  return roundMoney(Math.max(0, invoiceTotal - settled), currency);
}

/**
 * Moneda en la que se le EXPRESA el cobro a quien esta mirando la pantalla.
 *
 * REGLA DE NEGOCIO: al CLIENTE, el saldo de un tramite de Paqueteria se le dice
 * siempre en dolares y nunca convertido a colones. No es una preferencia de
 * formato: sus lineas de costo son USD-only (`allowedCurrencies`), asi que el
 * dolar es la cifra EXACTA y el colon la derivada de una tasa. Enseñarle las dos
 * le da dos numeros para la misma deuda y le obliga a preguntar con cual se le
 * va a cobrar.
 *
 * El STAFF sigue leyendo colones en todo: es la moneda de cobro local, la que
 * cuadra contra el banco y la que decide si el tramite esta saldado
 * (`isSettled`). Cambiar eso seria cambiar la contabilidad, no la presentacion.
 *
 * Punto UNICO de esa eleccion. La bandera del listado, el bloque de facturacion
 * de la ficha y la pantalla de pago tienen que coincidir; con la condicion
 * escrita en tres sitios, tarde o temprano no coinciden.
 */
export function billingCurrencyFor(shipmentType: ShipmentType, role: Role): Currency {
  const isPaqueteria = flowForType(shipmentType) === Flow.Paqueteria;
  return role === Role.Client && isPaqueteria ? Currency.USD : Currency.CRC;
}

/** Cifras del cobro de un tramite en las DOS monedas, tal como llegan de la API. */
export interface BillingFigures {
  invoiceTotalUsd: number | null;
  invoiceTotalCrc: number | null;
  settledUsd: number;
  settledCrc: number;
  pendingUsd: number;
  pendingCrc: number;
}

/** Las mismas cifras ya resueltas en UNA moneda: la que toca mostrar. */
export interface BillingAmounts {
  currency: Currency;
  /** Monto de factura congelado; null = costos aun sin aprobar. */
  invoiceTotal: number | null;
  /** Abonado CONFIRMADO. */
  paid: number;
  /** Abonos subidos y aun sin validar. No es dinero recibido. */
  pending: number;
  /** Lo que falta por cobrar. */
  due: number;
}

/**
 * Proyecta las cifras del cobro a la moneda en que se van a leer. Punto UNICO de
 * esa eleccion de columna: quien pinta el saldo no vuelve a preguntarse cual de
 * los dos pares de campos le tocaba.
 *
 * `settled` (si el tramite esta cubierto) se decide SIEMPRE en colones, aqui y en
 * `isSettled`, y por eso entra como dato y no se rededuce: es una pregunta de
 * contabilidad, no de presentacion.
 *
 * El SALDO ES LO QUE DIGA `settled`, y por eso esta funcion recibe ese booleano.
 * Las dos columnas se cuadran contra la misma factura pero por caminos con
 * redondeos distintos, y en los bordes pueden discrepar por una unidad; cuando
 * eso pasa manda la contabilidad, no la aritmetica de la columna que se esta
 * mostrando:
 *
 *   - Saldado -> el saldo es CERO. Un "$0.01" al lado de una bandera que dice
 *     "Pagado" es la ficha contradiciendose a si misma.
 *   - Sin saldar -> el saldo no baja de la unidad mas pequeña de la moneda. Un
 *     tramite con ₡1 abierto son $0.002, que redondeados se leen "Saldo $0.00":
 *     el cliente entiende que no debe nada mientras el sistema le sigue
 *     reteniendo el paquete.
 */
export function billingAmounts(
  figures: BillingFigures,
  currency: Currency,
  settled: boolean,
): BillingAmounts {
  const usd = currency === Currency.USD;
  const invoiceTotal = usd ? figures.invoiceTotalUsd : figures.invoiceTotalCrc;
  const paid = usd ? figures.settledUsd : figures.settledCrc;

  return {
    currency,
    invoiceTotal,
    paid,
    pending: usd ? figures.pendingUsd : figures.pendingCrc,
    due: dueFor(paid, invoiceTotal, currency, settled),
  };
}

/** El saldo a MOSTRAR, arbitrado por `settled` (ver `billingAmounts`). */
function dueFor(
  paid: number,
  invoiceTotal: number | null,
  currency: Currency,
  settled: boolean,
): number {
  if (invoiceTotal == null) return 0;
  if (settled) return 0;
  return Math.max(outstanding(paid, invoiceTotal, currency), smallestUnit(currency));
}

/**
 * True si el saldo por cobrar YA esta cubierto por abonos en validacion: el
 * cliente pago y lo que falta es que alguien mire el comprobante.
 *
 * Es el punto UNICO que decide "este tramite no admite otro pago". Lo consultan
 * la guarda del servidor que rechaza un segundo abono, la pantalla de pago que
 * esconde el formulario y la bandera del listado; responder distinto en
 * cualquiera de los tres es exactamente como el cliente termina pagando dos
 * veces por lo mismo.
 *
 * Un abono parcial en validacion NO cuenta: el tramite conserva saldo y ese
 * saldo alguien tiene que pagarlo. Y si ya esta cubierto por dinero confirmado
 * el saldo es 0, con lo que tampoco aplica: eso es `isSettled`, no esto.
 */
export function awaitsValidation(
  settledCrc: number,
  pendingCrc: number,
  invoiceTotalCrc: number | null,
): boolean {
  if (invoiceTotalCrc == null || pendingCrc <= 0) return false;
  const dueCrc = outstandingCrc(settledCrc, invoiceTotalCrc);
  return dueCrc > 0 && pendingCrc >= dueCrc;
}

/**
 * ESTATUS COBRO del tramite, tal como lo pide el reporte (campo 16 de
 * Paqueteria, campo 13 de Agenciamiento).
 *
 * NO es una columna: se deriva de los abonos en cada lectura, igual que
 * `isSettled` y por la misma razon (decision 3 de este archivo: "pagado" no se
 * guarda). Lo que aporta sobre `settled` es distinguir los tres casos que al
 * administrador le importan y que un booleano aplasta en uno: todavia no hay
 * nada que cobrar, el cliente no ha pagado, y el cliente pago pero el
 * comprobante sigue sin validar.
 */
export enum CollectionStatus {
  /** Sin factura aprobada: no hay monto que cobrar todavia. */
  SinFacturar = 'sin_facturar',
  /** Facturado y sin abonos que lo cubran. */
  Pendiente = 'pendiente',
  /** Hay comprobantes subidos sin resolver. No es dinero recibido. */
  EnValidacion = 'en_validacion',
  /** Lo confirmado cubre la factura. */
  Pagado = 'pagado',
}

export const COLLECTION_STATUS_LABELS: Record<CollectionStatus, string> = {
  [CollectionStatus.SinFacturar]: 'Sin facturar',
  [CollectionStatus.Pendiente]: 'Pendiente de pago',
  [CollectionStatus.EnValidacion]: 'En validación',
  [CollectionStatus.Pagado]: 'Pagado',
};

/**
 * Estatus de cobro de un tramite. Punto UNICO de esa clasificacion.
 *
 * El orden de las preguntas importa: PAGADO manda sobre EN VALIDACION, porque un
 * tramite ya cubierto con un comprobante extra pendiente esta pagado, no en
 * revision. Se apoya en `isSettled` en vez de repetir la comparacion para que la
 * etiqueta del reporte y la guarda que deja salir el paquete a ruta
 * (Condition.RequiresConfirmedPayment) no puedan discrepar.
 */
export function collectionStatus(
  payments: readonly Settleable[],
  invoiceTotalCrc: number | null,
): CollectionStatus {
  if (invoiceTotalCrc == null) return CollectionStatus.SinFacturar;
  if (isSettled(payments, invoiceTotalCrc)) return CollectionStatus.Pagado;
  if (pendingAmount(payments, Currency.CRC) > 0) return CollectionStatus.EnValidacion;
  return CollectionStatus.Pendiente;
}

/**
 * Instante en que el tramite quedo cubierto: la confirmacion MAS RECIENTE entre
 * los abonos que lo pagaron. Es la FECHA de pago del reporte (campo 19 de
 * Paqueteria, campo 16 de Agenciamiento: "momento en que el paquete pasa a
 * estado Pagado").
 *
 * El ultimo y no el primero porque es cuando la deuda se cerro: con dos abonos
 * parciales, el primero no pago nada todavia. Null si el tramite aun no esta
 * cubierto, o si esta cubierto por abonos sin sello de confirmacion.
 */
export function settledAt(
  payments: readonly (Settleable & { confirmedAt: Date | string | null })[],
  invoiceTotalCrc: number | null,
): Date | null {
  if (!isSettled(payments, invoiceTotalCrc)) return null;

  let latest: Date | null = null;
  for (const payment of payments) {
    if (payment.status !== PaymentStatus.Confirmado || !payment.confirmedAt) continue;
    const at = payment.confirmedAt instanceof Date ? payment.confirmedAt : new Date(payment.confirmedAt);
    if (!latest || at > latest) latest = at;
  }
  return latest;
}

/** Valores para construir los enums de la BD (Drizzle pgEnum), sin repetirlos. */
export const PAYMENT_METHOD_VALUES = Object.values(PaymentMethod) as [
  PaymentMethod,
  ...PaymentMethod[],
];
export const PAYMENT_STATUS_VALUES = Object.values(PaymentStatus) as [
  PaymentStatus,
  ...PaymentStatus[],
];
export const BANK_ACCOUNT_VALUES = Object.values(BankAccount) as [BankAccount, ...BankAccount[]];
