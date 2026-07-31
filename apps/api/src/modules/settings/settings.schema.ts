/**
 * Ajustes generales del sistema. Dos tablas con papeles distintos:
 *
 *   - `app_settings`: UNA fila con los valores vigentes. Es la que consulta todo
 *     el sistema (cargar costos, registrar un pago), asi que se lee por clave
 *     primaria y sin ordenar ni agregar nada.
 *   - `exchange_rate_history`: append-only, una fila por cambio de la tasa. Es el
 *     rastro de auditoria que explica por que una factura vieja tiene otra tasa.
 *     Nunca se lee para operar.
 *
 * La fila unica se garantiza con un CHECK sobre el id: sin el, un INSERT suelto
 * (script, correccion manual) dejaria dos "valores vigentes" y la lectura pasaria
 * a depender del orden de las filas.
 */
import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from '../auth/auth.schema';

/** Clave de la unica fila de `app_settings`. */
export const SETTINGS_ROW_ID = 'global';

export const appSettings = pgTable(
  'app_settings',
  {
    id: text('id').primaryKey().default(SETTINGS_ROW_ID),
    /**
     * Tasa de cambio vigente del sistema, colones por 1 USD. Nullable a
     * proposito: antes de que alguien la fije NO hay tasa, y eso es distinto de
     * que sea cero. Quien la necesite para guardar un monto tiene que fallar,
     * no asumir un valor (regla M5).
     */
    exchangeRate: doublePrecision('exchange_rate'),
    exchangeRateSetBy: uuid('exchange_rate_set_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    exchangeRateSetAt: timestamp('exchange_rate_set_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('app_settings_singleton', sql`${t.id} = 'global'`),
    // Misma regla que en cada linea de costo y en cada pago (M5): si hay tasa, es
    // positiva. La BD es la ultima linea, la que tambien cubre un UPDATE a mano.
    check('app_settings_rate_positive', sql`${t.exchangeRate} IS NULL OR ${t.exchangeRate} > 0`),
  ],
);

export const exchangeRateHistory = pgTable(
  'exchange_rate_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Tasa que quedo vigente con este cambio. */
    rate: doublePrecision('rate').notNull(),
    /** La que estaba antes; null en el primer registro (no habia ninguna). */
    previousRate: doublePrecision('previous_rate'),
    note: text('note'),
    setBy: uuid('set_by').references(() => users.id, { onDelete: 'set null' }),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('exchange_rate_history_set_at_idx').on(t.setAt),
    check('exchange_rate_history_rate_positive', sql`${t.rate} > 0`),
  ],
);

export type AppSettingsRow = typeof appSettings.$inferSelect;
export type ExchangeRateHistoryRow = typeof exchangeRateHistory.$inferSelect;
