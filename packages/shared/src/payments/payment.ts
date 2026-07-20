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
import { Currency, convertMoney, roundMoney } from '../money/currency';

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
 * "Cuenta (BAC, BCR)"). Valores de dominio: los nombres reales de los bancos.
 */
export enum BankAccount {
  BAC = 'BAC',
  BCR = 'BCR',
}

export const BANK_ACCOUNT_LABELS: Record<BankAccount, string> = {
  [BankAccount.BAC]: 'BAC Credomatic',
  [BankAccount.BCR]: 'Banco de Costa Rica',
};

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
  const total = payments
    .filter((p) => p.status === PaymentStatus.Confirmado)
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
