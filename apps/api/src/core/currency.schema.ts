/**
 * Enum de Postgres para la moneda de los campos monetarios (CRC/USD). Vive aqui,
 * compartido, porque lo usan varias tablas (tarifas, servicios de costo, y a
 * futuro los montos que se cargan sobre los paquetes). Los valores salen de
 * @courier/shared (fuente unica del dominio, regla M2).
 */
import { pgEnum } from 'drizzle-orm/pg-core';
import { CURRENCY_VALUES } from '@courier/shared';

export const currencyEnum = pgEnum('currency', CURRENCY_VALUES);
