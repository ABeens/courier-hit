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
 * LOS VALORES LOS FIJA EL ADMINISTRADOR en Configuración (permiso
 * `card_surcharge.write`), igual que la tasa de cambio y la tarifa de flete: la
 * pasarela renegocia sus condiciones y esperar un despliegue para reflejarlo
 * seria cobrar de menos mientras tanto. Lo que vive aqui es el DEFECTO, el que
 * rige mientras nadie haya fijado otro.
 */
import { CURRENCY_DECIMALS, Currency, ceilMoney, convertMoney, roundMoney } from '../money/currency';

/** Lo que cobra la pasarela por un cobro con tarjeta. */
export interface CardSurchargeRate {
  /**
   * Porcentaje sobre el total cobrado, DE 0 A 100 (3.9 = 3,9 %). Misma convencion
   * que el resto de porcentajes del sistema (regla M3), para que el numero que
   * digita el administrador sea el mismo que viaja hasta aqui: con la mitad del
   * sistema en tanto por uno y la otra mitad en por ciento, la division por cien
   * acaba haciendose dos veces o ninguna.
   */
  percent: number;
  /** Cargo fijo por transaccion aprobada, en DOLARES (asi lo cobra la pasarela). */
  fixedUsd: number;
}

/**
 * Tarifa de Onvo Pay publicada para tarjeta: 3,9 % + $0,35 por transaccion
 * exitosa (https://onvopay.com/pricing).
 *
 * Es el DEFECTO, no la verdad: rige mientras nadie haya fijado otra en
 * Configuración. Sirve para que el sistema cobre bien desde el primer dia y para
 * que una instalacion nueva no tenga que adivinar un numero.
 */
export const DEFAULT_CARD_SURCHARGE: CardSurchargeRate = {
  percent: 3.9,
  fixedUsd: 0.35,
};

/**
 * Como se llama el recargo en la factura del tramite. Punto UNICO de ese texto:
 * lo lleva la linea de costo que se asienta al cobrarse la tarjeta y es lo que el
 * cliente lee en la proforma.
 */
export const CARD_SURCHARGE_LABEL = 'Comisión bancaria por pago con tarjeta';

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
  rate: CardSurchargeRate = DEFAULT_CARD_SURCHARGE,
): CardCharge {
  const base = roundMoney(Math.max(0, amount), currency);
  if (base <= 0) return { currency, amount: base, surcharge: 0, total: base };

  /**
   * Una comision del 100 % no tiene despeje posible (el total se iria a
   * infinito). Es un valor imposible en una pasarela real, pero la division de
   * abajo lo convertiria en un cobro absurdo en vez de en un error.
   */
  if (!(rate.percent >= 0 && rate.percent < 100)) {
    throw new Error('El porcentaje de comisión de la pasarela no es válido.');
  }
  const share = rate.percent / 100;

  const fixed = convertMoney(rate.fixedUsd, Currency.USD, currency, exchangeRate);

  /**
   * El despeje: si la pasarela se queda `percent` del total mas el fijo, el total
   * que deja neto el saldo es (saldo + fijo) / (1 - percent).
   *
   * Hacia ARRIBA a la unidad de la moneda (`ceilMoney`): redondear al mas cercano
   * puede dejar el cobro un centimo por debajo de la comision, y ese centimo lo
   * pondria la empresa. Es la unica direccion segura.
   */
  const total = ceilMoney((base + fixed) / (1 - share), currency);

  return { currency, amount: base, surcharge: roundMoney(total - base, currency), total };
}

/**
 * Reparte un importe entre varias partes en proporcion a sus pesos SIN perder ni
 * inventar una unidad: la suma del reparto es exactamente el importe original.
 *
 * Lo necesita el cobro agrupado. La comision es UNA sola (un cargo por la
 * tarjeta) pero la factura que sube es la de CADA paquete, asi que hay que
 * repartirla; y el reparto tiene que cuadrar al centimo, porque cada paquete se
 * da por pagado comparando su abono contra su propia factura. Un centimo perdido
 * en el reparto es un paquete que se queda retenido por un centimo.
 *
 * Metodo del RESTO MAYOR: se reparte la parte entera de cada porcion y las
 * unidades que sobran por el redondeo van a las partes con mayor resto, una cada
 * una. Sin pesos (o con todos en cero) el importe entero va a la primera parte:
 * no hay proporcion que aplicar y perderlo seria peor.
 */
export function splitAmount(
  total: number,
  weights: readonly number[],
  currency: Currency,
): number[] {
  const parts = weights.length;
  if (parts === 0) return [];

  const unit = 10 ** CURRENCY_DECIMALS[currency];
  const units = Math.round(total * unit);
  const sum = weights.reduce((acc, w) => acc + w, 0);

  if (sum <= 0) {
    const first = Array<number>(parts).fill(0);
    first[0] = units / unit;
    return first;
  }

  const exact = weights.map((w) => (units * w) / sum);
  const floors = exact.map((v) => Math.floor(v));
  let left = units - floors.reduce((acc, v) => acc + v, 0);

  /** Los indices con mayor resto se llevan las unidades sueltas, una cada uno. */
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest);

  for (const { index } of order) {
    if (left <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    left -= 1;
  }

  return floors.map((v) => v / unit);
}
