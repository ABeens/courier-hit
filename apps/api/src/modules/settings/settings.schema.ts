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

    /**
     * Tarifa de transporte internacional vigente: lo que a HS Global le cuesta
     * mover una LIBRA desde Miami, en dolares. Alimenta el campo 21 del reporte
     * de Paqueteria.
     *
     * Nullable por lo mismo que la tasa: antes de que alguien la fije NO hay
     * tarifa, y eso es distinto de que sea cero. El reporte deja la columna vacia
     * en vez de calcular con un cero que diria que traer el paquete fue gratis.
     */
    freightRateUsdPerLb: doublePrecision('freight_rate_usd_per_lb'),
    freightRateSetBy: uuid('freight_rate_set_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    freightRateSetAt: timestamp('freight_rate_set_at', { withTimezone: true }),

    /**
     * RECARGO POR PAGO CON TARJETA: lo que cobra la pasarela por cada cobro y que
     * se le traslada al cliente. Porcentaje del total (0 a 100) mas un fijo por
     * transaccion en dolares.
     *
     * Nullables, pero NO por la razon de la tasa: aqui si hay un defecto honesto
     * (`DEFAULT_CARD_SURCHARGE`, la tarifa publicada de Onvo) y el sistema cobra
     * con el mientras nadie fije otro. Null significa "nadie lo ha tocado", que
     * es lo que la pantalla necesita decir para no presentar un valor de fabrica
     * como una decision del negocio.
     *
     * Las DOS cifras se guardan juntas: son una sola condicion comercial con dos
     * partes, y una mezcla de la tarifa nueva con la vieja no es la de ningun
     * contrato.
     */
    cardSurchargePercent: doublePrecision('card_surcharge_percent'),
    cardSurchargeFixedUsd: doublePrecision('card_surcharge_fixed_usd'),
    cardSurchargeSetBy: uuid('card_surcharge_set_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    cardSurchargeSetAt: timestamp('card_surcharge_set_at', { withTimezone: true }),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('app_settings_singleton', sql`${t.id} = 'global'`),
    // Misma regla que en cada linea de costo y en cada pago (M5): si hay tasa, es
    // positiva. La BD es la ultima linea, la que tambien cubre un UPDATE a mano.
    check('app_settings_rate_positive', sql`${t.exchangeRate} IS NULL OR ${t.exchangeRate} > 0`),
    check(
      'app_settings_freight_rate_positive',
      sql`${t.freightRateUsdPerLb} IS NULL OR ${t.freightRateUsdPerLb} > 0`,
    ),
    /**
     * Rango del porcentaje (regla M3), con el mismo techo que el esquema Zod. El
     * 100 no entra: con esa comision el despeje del total no existe
     * (`cardChargeFor`) y el cobro se iria a infinito.
     */
    check(
      'app_settings_card_surcharge_percent_range',
      sql`${t.cardSurchargePercent} IS NULL OR (${t.cardSurchargePercent} >= 0 AND ${t.cardSurchargePercent} < 100)`,
    ),
    check(
      'app_settings_card_surcharge_fixed_nonneg',
      sql`${t.cardSurchargeFixedUsd} IS NULL OR ${t.cardSurchargeFixedUsd} >= 0`,
    ),
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

/**
 * Historial de la tarifa de transporte internacional. Mismo papel que
 * `exchange_rate_history` y por el mismo motivo, agravado: esta tarifa determina
 * el margen que reporta el negocio, asi que un cambio sin rastro deja un salto en
 * la rentabilidad de un mes a otro que nadie puede explicar despues.
 */
export const freightRateHistory = pgTable(
  'freight_rate_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** USD por libra que quedo vigente con este cambio. */
    usdPerLb: doublePrecision('usd_per_lb').notNull(),
    /** La que estaba antes; null en el primer registro. */
    previousUsdPerLb: doublePrecision('previous_usd_per_lb'),
    note: text('note'),
    setBy: uuid('set_by').references(() => users.id, { onDelete: 'set null' }),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('freight_rate_history_set_at_idx').on(t.setAt),
    check('freight_rate_history_positive', sql`${t.usdPerLb} > 0`),
  ],
);

/**
 * Historial del recargo por pago con tarjeta. Mismo papel que los otros dos
 * historiales y por el mismo motivo: este numero decide lo que se le cobra de mas
 * a TODOS los clientes que paguen con tarjeta, y un cambio sin rastro deja un
 * salto en la facturacion que nadie puede explicar despues.
 *
 * Guarda las dos cifras juntas, vigentes y anteriores: la tarifa es el par, y un
 * historial que solo contara el porcentaje no dejaria reconstruir con que se
 * cobro.
 */
export const cardSurchargeHistory = pgTable(
  'card_surcharge_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    percent: doublePrecision('percent').notNull(),
    fixedUsd: doublePrecision('fixed_usd').notNull(),
    /** Los que estaban antes; null en el primer registro (regian los de fabrica). */
    previousPercent: doublePrecision('previous_percent'),
    previousFixedUsd: doublePrecision('previous_fixed_usd'),
    note: text('note'),
    setBy: uuid('set_by').references(() => users.id, { onDelete: 'set null' }),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('card_surcharge_history_set_at_idx').on(t.setAt),
    check('card_surcharge_history_percent_range', sql`${t.percent} >= 0 AND ${t.percent} < 100`),
    check('card_surcharge_history_fixed_nonneg', sql`${t.fixedUsd} >= 0`),
  ],
);

export type AppSettingsRow = typeof appSettings.$inferSelect;
export type ExchangeRateHistoryRow = typeof exchangeRateHistory.$inferSelect;
export type FreightRateHistoryRow = typeof freightRateHistory.$inferSelect;
export type CardSurchargeHistoryRow = typeof cardSurchargeHistory.$inferSelect;
