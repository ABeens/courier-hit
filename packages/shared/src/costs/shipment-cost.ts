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
 *    sistema la SUGIERE (BCCR) pero el operador es quien la digita.
 * 3. LOS TOTALES SE DERIVAN, NO SE DIGITAN. `computeTotals` es el unico lugar
 *    donde se suma una factura, y devuelve el total en ambas monedas.
 */
import { Currency, convertMoney, roundMoney } from '../money/currency';

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
