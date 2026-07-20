/**
 * Moneda del dominio. HS Global Courier opera con dos monedas: colon
 * costarricense (CRC) y dolar estadounidense (USD). Todo campo monetario del
 * sistema lleva su moneda de forma EXPLICITA (regla M2 de money-rules): nunca se
 * asume por contexto.
 *
 * La tasa de cambio NO vive aqui: los valores de catalogo (tarifas, servicios)
 * solo llevan moneda; la tasa se captura como snapshot al cargar los costos sobre
 * un paquete (regla M5). Ver .claude/money-rules.config.json.
 *
 * Enum de dominio: los valores (CRC/USD, codigos ISO 4217) son estables y
 * alimentan un enum de Postgres.
 */

/** Moneda soportada por el negocio (ISO 4217). */
export enum Currency {
  /** Colon costarricense. */
  CRC = 'CRC',
  /** Dolar estadounidense. */
  USD = 'USD',
}

/** Etiqueta de presentacion de la moneda. */
export const CURRENCY_LABELS: Record<Currency, string> = {
  [Currency.CRC]: 'Colón (CRC)',
  [Currency.USD]: 'Dólar (USD)',
};

/** Simbolo para mostrar junto al monto. */
export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  [Currency.CRC]: '₡',
  [Currency.USD]: '$',
};

/**
 * Decimales de presentacion por moneda (politica de redondeo, regla M4):
 * USD a 2 decimales, CRC a 0 (los colones no se manejan con centimos).
 */
export const CURRENCY_DECIMALS: Record<Currency, number> = {
  [Currency.CRC]: 0,
  [Currency.USD]: 2,
};

/** Valores para construir el enum de la BD (Drizzle pgEnum), sin repetirlos. */
export const CURRENCY_VALUES = Object.values(Currency) as [Currency, ...Currency[]];

/**
 * Formatea un monto con su simbolo y la cantidad de decimales de la moneda.
 * Punto UNICO de redondeo de presentacion (regla M4): no llamar `toFixed` suelto.
 */
export function formatMoney(value: number, currency: Currency): string {
  return `${CURRENCY_SYMBOLS[currency]}${value.toFixed(CURRENCY_DECIMALS[currency])}`;
}

/**
 * Redondea un monto a los decimales de su moneda. Punto UNICO de redondeo de
 * CALCULO (regla M4), hermano de `formatMoney` para la presentacion: todo importe
 * derivado (conversiones, porcentajes, totales) pasa por aqui antes de guardarse.
 */
export function roundMoney(value: number, currency: Currency): number {
  const factor = 10 ** CURRENCY_DECIMALS[currency];
  return Math.round(value * factor) / factor;
}

/**
 * Convierte un monto entre CRC y USD con una tasa EXPLICITA.
 *
 * Convencion de la tasa en todo el sistema: **colones por 1 USD** (p. ej. 512.75).
 * Nunca se asume una tasa por contexto (regla M5): siempre viaja junto al monto.
 * Devuelve el valor ya redondeado a los decimales de la moneda destino.
 */
export function convertMoney(
  value: number,
  from: Currency,
  to: Currency,
  crcPerUsd: number,
): number {
  if (from === to) return roundMoney(value, to);
  if (!(crcPerUsd > 0)) throw new Error('La tasa de cambio debe ser mayor que cero.');
  const converted = from === Currency.USD ? value * crcPerUsd : value / crcPerUsd;
  return roundMoney(converted, to);
}
