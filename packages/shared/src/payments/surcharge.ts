/**
 * RECARGO POR PAGAR CON TARJETA: la comision de la pasarela, trasladada al
 * cliente que elige ese medio.
 *
 * Onvo Pay cobra un porcentaje del cobro mas un fijo por transaccion. Quien paga
 * por deposito bancario no genera esa comision, asi que cargarsela a todos por
 * igual la enterraria en la tarifa; aqui la paga quien la provoca y la ve antes
 * de aceptar.
 *
 * Tres decisiones que viven aqui:
 *
 * 1. EL RECARGO NO ES PARTE DE LA FACTURA. Lo facturado es lo facturado: el
 *    abono que cancela el tramite sigue siendo el saldo (`amount`), y el recargo
 *    viaja al lado (`surcharge`). Meterlo en el abono haria que el cliente
 *    apareciera pagando de mas contra su propia factura y que el reporte
 *    financiero contara como ingreso un dinero que se queda en la pasarela.
 * 2. SE CALCULA HACIA ARRIBA (gross-up), no como un simple porcentaje encima. La
 *    comision se cobra sobre el TOTAL que pasa por la tarjeta, recargo incluido:
 *    sumarle un 3,9 % al saldo deja a la empresa poniendo la comision de la
 *    comision. La formula despeja el total que, despues de que la pasarela se
 *    cobre lo suyo, deja neto exactamente el saldo facturado.
 * 3. EL FIJO ESTA EN DOLARES y se convierte con la tasa del cobro, porque asi lo
 *    cobra la pasarela. Un cobro en colones lleva el equivalente del fijo, no un
 *    fijo en colones inventado.
 *
 * Los valores viven en el codigo, como `BANK_ACCOUNTS`: son condiciones
 * comerciales que cambian cada varios años, no un dato que el administrador
 * mantenga. Si algun dia se editan desde Configuración, este es el unico lugar
 * del que salen y mover la fuente no rompe a quien los consume.
 */
import { Currency, ceilMoney, convertMoney, formatMoney, roundMoney } from '../money/currency';

/** Lo que cobra la pasarela por un cobro con tarjeta. */
export interface CardSurchargeRate {
  /** Porcentaje sobre el total cobrado, en tanto por uno (0.039 = 3,9 %). */
  percent: number;
  /** Cargo fijo por transaccion aprobada, en DOLARES (asi lo cobra la pasarela). */
  fixedUsd: number;
}

/**
 * Tarifa vigente de Onvo Pay para tarjeta: 3,9 % + $0,35 por transaccion exitosa
 * (https://onvopay.com/pricing). Punto UNICO de esas dos cifras.
 */
export const CARD_SURCHARGE: CardSurchargeRate = {
  percent: 0.039,
  fixedUsd: 0.35,
};

/** El cobro con tarjeta desglosado, todo en la MISMA moneda. */
export interface CardCharge {
  currency: Currency;
  /** Lo que cancela la factura: el saldo del tramite, intacto. */
  amount: number;
  /** El recargo trasladado. Cero cuando no hay nada que cobrar. */
  surcharge: number;
  /** Lo que se le cobra a la tarjeta y lo que el cliente ve en su estado de cuenta. */
  total: number;
}

/**
 * Desglosa un cobro con tarjeta: saldo, recargo y total.
 *
 * Punto UNICO de esa cuenta. La cifra que anuncia la pantalla antes de pagar, la
 * que se le manda a la pasarela y la que se guarda en el abono salen de aqui;
 * calculada en tres sitios, tarde o temprano el cliente acepta un importe y se
 * le cobra otro.
 *
 * `exchangeRate` es la tasa congelada del cobro (regla M5), la misma que se
 * guarda en el abono: solo se usa para pasar el fijo en dolares a la moneda del
 * cobro, y en un cobro en dolares no interviene.
 *
 * Sin saldo no hay cobro y por tanto no hay comision que trasladar: recargo cero.
 */
export function cardChargeFor(
  amount: number,
  currency: Currency,
  exchangeRate: number,
  rate: CardSurchargeRate = CARD_SURCHARGE,
): CardCharge {
  const base = roundMoney(Math.max(0, amount), currency);
  if (base <= 0) return { currency, amount: base, surcharge: 0, total: base };

  /**
   * Una comision del 100 % no tiene despeje posible (el total se iria a
   * infinito). Es un valor imposible en una pasarela real, pero la division de
   * abajo lo convertiria en un cobro absurdo en vez de en un error.
   */
  if (!(rate.percent >= 0 && rate.percent < 1)) {
    throw new Error('El porcentaje de comisión de la pasarela no es válido.');
  }

  const fixed = convertMoney(rate.fixedUsd, Currency.USD, currency, exchangeRate);

  /**
   * El despeje: si la pasarela se queda `percent` del total mas el fijo, el total
   * que deja neto el saldo es (saldo + fijo) / (1 - percent).
   *
   * Hacia ARRIBA a la unidad de la moneda (`ceilMoney`): redondear al mas cercano
   * puede dejar el cobro un centimo por debajo de la comision, y ese centimo lo
   * pondria la empresa. Es la unica direccion segura.
   */
  const total = ceilMoney((base + fixed) / (1 - rate.percent), currency);

  return { currency, amount: base, surcharge: roundMoney(total - base, currency), total };
}

/** La tarifa dicha en una linea, para explicarle al cliente de donde sale el recargo. */
export function cardSurchargeLabel(rate: CardSurchargeRate = CARD_SURCHARGE): string {
  const percent = Number((rate.percent * 100).toFixed(2));
  return `${percent}% + ${formatMoney(rate.fixedUsd, Currency.USD)}`;
}
