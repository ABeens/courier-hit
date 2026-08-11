/**
 * Tabla Drizzle del catalogo de servicios de costo (panel admin).
 * Un servicio es un concepto que el administrador carga sobre los tramites, sea
 * de Transporte y Agenciamiento o de Paqueteria (docs/manuales/flujo.md L1-20).
 * Los enums de tipo de servicio y de tipo de valor salen de @courier/shared
 * (fuente unica).
 */
import { boolean, doublePrecision, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  COST_CATEGORY_VALUES,
  DEFAULT_COST_CATEGORY,
  SERVICE_KIND_VALUES,
  SERVICE_VALUE_TYPE_VALUES,
  ServiceKind,
} from '@courier/shared';
import { currencyEnum } from '../../core/currency.schema';

export const serviceKindEnum = pgEnum('service_kind', SERVICE_KIND_VALUES);
export const serviceValueTypeEnum = pgEnum('service_value_type', SERVICE_VALUE_TYPE_VALUES);
export const costCategoryEnum = pgEnum('cost_category', COST_CATEGORY_VALUES);

export const costServices = pgTable('cost_services', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  /** Los servicios existentes nacieron como Transporte y Agenciamiento. */
  kind: serviceKindEnum('kind').notNull().default(ServiceKind.TransporteAgenciamiento),
  /**
   * De quien es el dinero del concepto (ver `CostCategory`). El default aplica a
   * los servicios que existian antes de esta columna: se les supone TRASLADADOS,
   * que es el supuesto conservador (subestima el margen en vez de inventarlo).
   */
  category: costCategoryEnum('category').notNull().default(DEFAULT_COST_CATEGORY),
  /**
   * Codigo del concepto en el sistema de Factura Electronica (COD SIS FE de la
   * proforma). Identificador externo: se guarda tal cual. Null = sin asignar.
   */
  electronicInvoiceCode: text('electronic_invoice_code'),
  valueType: serviceValueTypeEnum('value_type').notNull(),
  /** Porcentaje o importe segun value_type; null cuando es 'manual'. */
  defaultValue: doublePrecision('default_value'),
  /** Moneda del importe; solo cuando value_type = 'fixed' (es dinero), null en otro caso. Regla M2. */
  currency: currencyEnum('currency'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CostServiceRow = typeof costServices.$inferSelect;
export type NewCostServiceRow = typeof costServices.$inferInsert;
