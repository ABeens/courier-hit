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
