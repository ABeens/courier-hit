/**
 * Costos cargados sobre un tramite: las lineas que forman su factura.
 *
 * Es la otra mitad del modulo de costos. El CATALOGO (`cost-service.ts`) define
 * QUE conceptos existen y cuanto valen por defecto; esto define CUANTO se le
 * cobro a un tramite concreto. Fuente: docs/06-modulo-administrativo.md §3.3.
 *
 * Tres decisiones que viven aqui:
 *
 * 1. LA LINEA ES UN SNAPSHOT. Guarda su propia etiqueta, monto, moneda y tasa de
 *    cambio. Si manana el administrador renombra el servicio del catalogo o le
 *    cambia el valor, la factura ya emitida no se mueve.
 * 2. LA TASA VIAJA CON EL MONTO (regla M5). Convencion unica del sistema:
 *    `exchangeRate` = colones por 1 USD. Se captura al cargar el costo; el
 *    sistema la SUGIERE (referencia publicada) pero el operador es quien la digita.
 * 3. LOS TOTALES SE DERIVAN, NO SE DIGITAN. `computeTotals` es el unico lugar
 *    donde se suma una factura, y devuelve el total en ambas monedas.
 */
import { Currency, convertMoney, roundMoney } from '../money/currency';
import { CostCategory, isPassThroughCost } from './cost-service';

/**
 * Origen del importe de una linea. Enum de comportamiento: valores en ingles.
 * Explica de donde salio el numero, que es lo que se le muestra al operador.
 */
export enum CostLineSource {
  /** Flete de Paqueteria: peso x precio por kg de la tarifa del cliente. */
  Freight = 'freight',
  /** Servicio del catalogo con importe fijo o digitado a mano. */
  Service = 'service',
  /** Servicio del catalogo de tipo porcentaje, resuelto sobre la base. */
  Percentage = 'percentage',
}

/** Etiqueta de presentacion del origen de la linea. */
export const COST_LINE_SOURCE_LABELS: Record<CostLineSource, string> = {
  [CostLineSource.Freight]: 'Flete',
  [CostLineSource.Service]: 'Servicio',
  [CostLineSource.Percentage]: 'Porcentaje',
};

/** Una linea de costo de un tramite (vista publica; forma equivalente a la fila de BD). */
export interface ShipmentCostLine {
  id: string;
  /** Servicio del catalogo del que salio; null si es el flete o un concepto suelto. */
  costServiceId: string | null;
  /** Etiqueta congelada al cargar (no se relee del catalogo). */
  label: string;
  /**
   * De quien es el dinero, congelado al cargar igual que la etiqueta. Se copia
   * del servicio del catalogo; en la linea de flete la fija el sistema
   * (`CostCategory.Flete`). Reclasificar el catalogo no mueve una factura vieja.
   */
  category: CostCategory;
  /** COD SIS FE del concepto, copiado del catalogo. Null si no lleva. */
  electronicInvoiceCode: string | null;
  source: CostLineSource;
  /** Porcentaje aplicado (0-100) cuando `source` es Percentage; null en el resto. */
  percentage: number | null;
  /** Importe de la linea, ya resuelto. Siempre >= 0 (regla M3). */
  amount: number;
  /** Moneda del importe, explicita (regla M2). */
  currency: Currency;
  /** Colones por 1 USD al momento de cargar el costo (regla M5). Siempre > 0. */
  exchangeRate: number;
  createdAt: Date;
}

/** Total de una factura, expresado en las dos monedas del negocio. */
export interface CostTotals {
  /** Suma en dolares de todas las lineas (cada una con SU tasa). */
  usd: number;
  /** Suma en colones de todas las lineas (cada una con SU tasa). */
  crc: number;
}

/** Datos minimos para totalizar: lo que comparten la linea guardada y la que se va a guardar. */
type Totalizable = Pick<ShipmentCostLine, 'amount' | 'currency' | 'exchangeRate'>;

/**
 * Suma las lineas en ambas monedas. Punto UNICO de totalizacion de una factura:
 * cada linea se convierte con SU PROPIA tasa (no con una tasa global), asi un
 * trámite cargado en dos dias distintos sigue cuadrando.
 */
export function computeTotals(lines: readonly Totalizable[]): CostTotals {
  let usd = 0;
  let crc = 0;
  for (const line of lines) {
    usd += convertMoney(line.amount, line.currency, Currency.USD, line.exchangeRate);
    crc += convertMoney(line.amount, line.currency, Currency.CRC, line.exchangeRate);
  }
  return { usd: roundMoney(usd, Currency.USD), crc: roundMoney(crc, Currency.CRC) };
}

/**
 * El total en la moneda pedida, sin volver a recorrer las lineas. Existe para no
 * repetir el ternario `currency === USD ? totals.usd : totals.crc` en cada sitio
 * que imprime un total: cuando manana haya una tercera moneda, este es el unico
 * punto que cambia.
 */
export function totalIn(totals: CostTotals, currency: Currency): number {
  return currency === Currency.USD ? totals.usd : totals.crc;
}

/**
 * MONEDA EN LA QUE SE TRAMITO la factura: la de sus propias lineas.
 *
 * No es lo mismo que "la moneda en la que se puede expresar": cualquier factura
 * se puede convertir a las dos (para eso viaja la tasa en cada linea). Es la
 * moneda en la que el operador cargo los importes, y por tanto la que el cliente
 * reconoce como la del cobro: un agenciamiento cargado en colones tiene que
 * imprimirse en colones, aunque el sistema sepa cuanto son en dolares.
 *
 * Con lineas mezcladas gana la que concentra el mayor importe (comparadas en
 * dolares, que es lo unico que hace comparables dos monedas). El empate
 * -incluida una factura en cero- se resuelve por la PRIMERA linea, que es la que
 * fijo la moneda del trámite: asi la respuesta no depende del orden en que se
 * sumo ni cambia sola entre dos llamadas.
 */
export function invoiceCurrency(lines: readonly Totalizable[]): Currency {
  let usdShare = 0;
  let crcShare = 0;
  for (const line of lines) {
    const inUsd = convertMoney(line.amount, line.currency, Currency.USD, line.exchangeRate);
    if (line.currency === Currency.USD) usdShare += inUsd;
    else crcShare += inUsd;
  }
  if (crcShare > usdShare) return Currency.CRC;
  if (usdShare > crcShare) return Currency.USD;
  return lines[0]?.currency ?? Currency.USD;
}

/**
 * Desglose de una factura por categoria, en UNA moneda. Todas las cifras salen
 * de las mismas lineas que produjeron el total: nunca se digitan.
 */
export interface CostBreakdown {
  /** Flete de Paqueteria. Es cobro al cliente, no costo (ver `CostCategory.Flete`). */
  flete: number;
  /** Columna IMPUESTOS del reporte de Paqueteria (campo 22). */
  impuestos: number;
  /** Columna OTROS / COMPRAS del reporte de Paqueteria (campo 23). */
  otros: number;
  /** Honorarios de HS Global. Tampoco es costo: es el margen. */
  propio: number;
  /**
   * Lo que de verdad cuesta el tramite: `impuestos + otros`. Es la columna
   * COSTOS ASOCIADOS del reporte de Agenciamiento (campo 20), y lo que hace que
   * su PROFIT (campo 21) no salga en cero.
   */
  passThrough: number;
}

/** Lo minimo para desglosar: la linea guardada lo cumple. */
type Categorizable = Totalizable & { category: CostCategory };

/**
 * Suma las lineas AGRUPADAS por categoria, en la moneda pedida y cada una con SU
 * propia tasa (mismo criterio que `computeTotals`, del que este es el hermano
 * desagregado: `computeTotals` responde "cuanto se factura" y este "de que esta
 * hecho ese numero").
 *
 * Punto UNICO del corte por categoria. Los dos reportes lo consumen: sin esto,
 * uno sumaria "impuestos + otros" y el otro las columnas por separado, y bastaria
 * que alguien clasificara distinto en un sitio para que dejaran de cuadrar entre
 * si sobre el mismo tramite.
 */
export function breakdownByCategory(
  lines: readonly Categorizable[],
  target: Currency,
): CostBreakdown {
  const sums: Record<CostCategory, number> = {
    [CostCategory.Flete]: 0,
    [CostCategory.Impuestos]: 0,
    [CostCategory.Otros]: 0,
    [CostCategory.Propio]: 0,
  };
  let passThrough = 0;

  for (const line of lines) {
    const amount = convertMoney(line.amount, line.currency, target, line.exchangeRate);
    sums[line.category] += amount;
    if (isPassThroughCost(line.category)) passThrough += amount;
  }

  // Se redondea al final, no linea a linea: redondear antes de sumar arrastra el
  // error de cada linea al total (misma politica que `computeTotals`).
  return {
    flete: roundMoney(sums[CostCategory.Flete], target),
    impuestos: roundMoney(sums[CostCategory.Impuestos], target),
    otros: roundMoney(sums[CostCategory.Otros], target),
    propio: roundMoney(sums[CostCategory.Propio], target),
    passThrough: roundMoney(passThrough, target),
  };
}

/**
 * Categoria que le toca a una linea. La del catalogo, SALVO en el flete, que la
 * fija el sistema: la linea de flete no sale de ningun servicio del catalogo y
 * su costo real lo calcula el reporte aparte (campo 21, TRANSPORTE INTL).
 *
 * Vive aqui para que la API (al guardar) y el reporte (al leer datos viejos)
 * respondan lo mismo.
 */
export function categoryForLine(
  source: CostLineSource,
  serviceCategory: CostCategory | null | undefined,
): CostCategory {
  if (source === CostLineSource.Freight) return CostCategory.Flete;
  return serviceCategory ?? CostCategory.Otros;
}

/**
 * Base sobre la que se calcula un servicio de tipo porcentaje: el subtotal de las
 * lineas que NO son porcentaje, convertido a la moneda del porcentaje.
 *
 * Los porcentajes no se aplican entre si (un 10% no se cobra sobre otro 10%):
 * si lo hicieran, el resultado dependeria del orden en que se cargaron.
 */
export function percentageBase(
  lines: readonly (Totalizable & { source: CostLineSource })[],
  target: Currency,
): number {
  const base = lines
    .filter((l) => l.source !== CostLineSource.Percentage)
    .reduce((sum, l) => sum + convertMoney(l.amount, l.currency, target, l.exchangeRate), 0);
  return roundMoney(base, target);
}

/** Importe de una linea de porcentaje sobre su base, redondeado a la moneda. */
export function applyPercentage(base: number, percentage: number, currency: Currency): number {
  return roundMoney((base * percentage) / 100, currency);
}

/** Valores para construir el enum de la BD (Drizzle pgEnum), sin repetirlos. */
export const COST_LINE_SOURCE_VALUES = Object.values(CostLineSource) as [
  CostLineSource,
  ...CostLineSource[],
];
