/**
 * Tabla Drizzle de las tarifas preferenciales de cliente (panel admin).
 * Categorias con precio por kg que se asignan a los casilleros (Basica, Plus,
 * Pro, Gold, Black, Platinum). Una es la tarifa por defecto.
 *
 * Invariante "un solo default": lo acota la BD con un indice unico PARCIAL sobre
 * is_default (solo puede haber una fila con is_default = true). Que SIEMPRE exista
 * al menos una la mantiene el servicio (create fuerza la primera; el borrado
 * protege la default).
 */
import { sql } from 'drizzle-orm';
import { boolean, doublePrecision, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const clientRates = pgTable(
  'client_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    pricePerKg: doublePrecision('price_per_kg').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    allowsCard: boolean('allows_card').notNull().default(true),
    allowsBankDeposit: boolean('allows_bank_deposit').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A lo sumo UNA tarifa por defecto (indice unico parcial). La BD lo garantiza.
    uniqueIndex('client_rates_one_default').on(t.isDefault).where(sql`${t.isDefault}`),
  ],
);

export type ClientRateRow = typeof clientRates.$inferSelect;
export type NewClientRateRow = typeof clientRates.$inferInsert;
