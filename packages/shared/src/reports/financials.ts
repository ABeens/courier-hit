/**
 * Aritmetica de los reportes por servicio: las columnas CALCULADAS del mapeo de
 * campos (Paqueteria 21, 24, 25, 26; Agenciamiento 18, 21, 22) y el MES derivado.
 *
 * Vive en `shared` y no en la API por la misma razon que `computeTotals` o
 * `settledAmount`: son formulas del negocio, no consultas. El dia que la pantalla
 * quiera mostrar el margen de un tramite en su ficha tiene que dar exactamente el
 * mismo numero que el CSV, y con la resta escrita en dos sitios tarde o temprano
 * no lo da.
 *
 * Todas las cifras van en USD. Es deliberado: el mapeo de Paqueteria cotiza en
 * dolares de punta a punta (MONTO FACTURA, IMPUESTOS, TRANSPORTE INTL) y mezclar
 * monedas dentro de una misma resta es justo lo que la regla M2 existe para
 * evitar. Quien necesite colones convierte el resultado con `convertMoney`.
 */
import { Currency, roundMoney } from '../money/currency';
import { KG_TO_LB } from '../settings/freight-rate-dto';

/**
 * TRANSPORTE INTL (campo 21 de Paqueteria): lo que nos cuesta traer el paquete.
 *
 *     (peso en kg × 2.204) × tarifa USD por libra
 *
 * Es el unico costo del reporte que NO sale de las lineas cargadas: la linea de
 * flete de `shipment_costs` es lo que se le COBRA al cliente (peso × tarifa del
 * casillero), y confundir las dos daria un margen de cero. Ver `CostCategory.Flete`.
 *
 * Null cuando falta cualquiera de los dos datos —el paquete todavia no tiene peso,
 * o nadie ha fijado la tarifa en Configuración— y eso es distinto de cero: un cero
 * se sumaria al total y el reporte diria que el paquete no costo nada traerlo.
 */
export function internationalFreightUsd(
  weightKg: number | null,
  usdPerLb: number | null,
): number | null {
  if (weightKg == null || usdPerLb == null) return null;
  return roundMoney(weightKg * KG_TO_LB * usdPerLb, Currency.USD);
}

/**
 * TOTAL de costos (campo 24 de Paqueteria): transporte internacional + impuestos
 * + otros/compras.
 *
 * El transporte internacional entra como `null` cuando no se pudo calcular, y en
 * ese caso el TOTAL tambien es null: sumarlo como cero daria un total que parece
 * completo y no lo esta, y de ahi saldria un GROSS PROFIT inflado. Las otras dos
 * columnas si son cero legitimo cuando no hay lineas de esa categoria (el tramite
 * no pago impuestos, y eso es un hecho, no un dato faltante).
 */
export function totalCostUsd(
  internationalFreight: number | null,
  taxes: number,
  others: number,
): number | null {
  if (internationalFreight == null) return null;
  return roundMoney(internationalFreight + taxes + others, Currency.USD);
}

/**
 * GROSS PROFIT / PROFIT (campo 25 de Paqueteria, 21 de Agenciamiento): lo
 * facturado menos lo que costo. Puede ser NEGATIVO, y por eso no pasa por
 * `Math.max(0, ...)` como el saldo de un cliente: un tramite que se vendio por
 * debajo del costo es exactamente lo que este reporte existe para encontrar.
 *
 * Null si falta cualquiera de los dos lados: sin factura aprobada no hay nada que
 * comparar, y sin costo completo la resta mentiria.
 */
export function grossProfitUsd(
  invoiceTotalUsd: number | null,
  totalCost: number | null,
): number | null {
  if (invoiceTotalUsd == null || totalCost == null) return null;
  return roundMoney(invoiceTotalUsd - totalCost, Currency.USD);
}

/**
 * % de margen (campo 26 de Paqueteria, 22 de Agenciamiento): profit / factura.
 *
 * Devuelve el PORCENTAJE (12.5 = 12,5%), no la fraccion, que es como lo lee quien
 * abre el CSV. Redondeado a dos decimales: no es dinero, asi que no pasa por
 * `roundMoney` (que aplica la politica de la moneda, y aqui no hay moneda).
 *
 * Null si no hay factura o si es cero: dividir entre cero daria Infinity, y un
 * tramite facturado en cero no tiene margen que expresar en porcentaje.
 */
export function marginPercentage(
  profit: number | null,
  invoiceTotalUsd: number | null,
): number | null {
  if (profit == null || !invoiceTotalUsd) return null;
  return Math.round((profit / invoiceTotalUsd) * 10_000) / 100;
}

/**
 * DIF (campo 18 de Agenciamiento): lo facturado menos lo efectivamente
 * depositado. Positivo = el cliente todavia debe; negativo = pago de mas.
 *
 * A diferencia de `outstandingCrc` de pagos, NO se acota a cero: ahi la pregunta
 * es "cuanto le queda por pagar" (un sobrepago no es deuda a favor) y aqui es
 * "cuanto se aparta el deposito de la factura", donde el sobrepago es justo la
 * anomalia que hay que ver.
 */
export function depositDifference(
  invoiceTotal: number | null,
  deposited: number,
  currency: Currency,
): number | null {
  if (invoiceTotal == null) return null;
  return roundMoney(invoiceTotal - deposited, currency);
}

/**
 * Zona horaria del negocio. Todos los clientes son de Costa Rica (CLAUDE.md), asi
 * que el "mes" de un reporte es el mes en Costa Rica, no en UTC.
 */
const BUSINESS_TIME_ZONE = 'America/Costa_Rica';

/**
 * MES del reporte (campo 13 de Paqueteria, 10 de Agenciamiento), derivado de la
 * fecha que corresponda: entrega en Paqueteria, facturacion en Agenciamiento.
 *
 * Formato `YYYY-MM` y no "junio 2026" porque la columna existe para AGRUPAR: en
 * una tabla dinamica o un ORDER BY, el nombre del mes ordena alfabeticamente
 * (abril antes que enero) y arrastra el ano por separado.
 *
 * La conversion a hora de Costa Rica no es un detalle de presentacion aqui, es
 * parte del dato: una entrega del 30 de junio a las 20:00 en Costa Rica es el 1
 * de julio en UTC, y contarla en julio descuadra el cierre del mes. Es la unica
 * razon por la que esta derivacion no se hace con `getUTCMonth`.
 */
export function monthOf(instant: Date | string | null): string | null {
  if (!instant) return null;
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;

  // `en-CA` da directamente `YYYY-MM-DD`, sin armar la cadena a mano.
  const day = date.toLocaleDateString('en-CA', { timeZone: BUSINESS_TIME_ZONE });
  return day.slice(0, 7);
}
