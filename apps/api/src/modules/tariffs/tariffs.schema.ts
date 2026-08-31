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
import {
  boolean,
  doublePrecision,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { CLIENT_RATE_KIND_VALUES, ClientRateKind } from '@courier/shared';
import { currencyEnum } from '../../core/currency.schema';

export const clientRateKindEnum = pgEnum('client_rate_kind', CLIENT_RATE_KIND_VALUES);

export const clientRates = pgTable(
  'client_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    /**
     * Tipo de tarifa. El default `estandar` es lo que ya hacian todas las tarifas
     * existentes (peso redondeado hacia arriba, cobro paquete a paquete), asi que
     * la columna entra sin tocar ninguna fila ni cambiarle el cobro a nadie.
     */
    kind: clientRateKindEnum('kind').notNull().default(ClientRateKind.Estandar),
    pricePerKg: doublePrecision('price_per_kg').notNull(),
    /** Moneda del precio por kg (explicita, regla M2). Sin tasa de cambio: es catalogo. */
    currency: currencyEnum('currency').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    allowsCard: boolean('allows_card').notNull().default(true),
    allowsBankDeposit: boolean('allows_bank_deposit').notNull().default(true),
    /**
     * La tarifa ocupa revision antes de facturar (OPS-003). El default `false` es
     * la regla del requisito ("las demas tarifas permiten que el paquete pase a
     * facturacion sin revision"), y de paso deja a las tarifas que ya existian
     * facturando solas sin tocar ninguna fila.
     */
    requiresBillingReview: boolean('requires_billing_review').notNull().default(false),
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
