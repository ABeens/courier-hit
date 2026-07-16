/**
 * Tabla Drizzle del catalogo de servicios de costo (panel admin).
 * Un servicio es un concepto que el administrador carga manualmente sobre los
 * tramites de Transporte y Agenciamiento (docs/manuales/flujo.md L1-20).
 * El enum de tipo de valor sale de @courier/shared (fuente unica).
 */
import { boolean, doublePrecision, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { SERVICE_VALUE_TYPE_VALUES } from '@courier/shared';

export const serviceValueTypeEnum = pgEnum('service_value_type', SERVICE_VALUE_TYPE_VALUES);

export const costServices = pgTable('cost_services', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  valueType: serviceValueTypeEnum('value_type').notNull(),
  /** Porcentaje o importe segun value_type; null cuando es 'manual'. */
  defaultValue: doublePrecision('default_value'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CostServiceRow = typeof costServices.$inferSelect;
export type NewCostServiceRow = typeof costServices.$inferInsert;
