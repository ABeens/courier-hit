/**
 * Tabla Drizzle de las lineas de costo de un tramite (`shipment_costs`).
 *
 * Cada fila es un SNAPSHOT: guarda su etiqueta, su monto, su moneda y su tasa de
 * cambio. El FK al catalogo es solo trazabilidad (`set null` al borrar): renombrar
 * o deshabilitar un servicio jamas debe alterar una factura ya cargada.
 *
 * El total NO vive aqui: se deriva con `computeTotals` de @courier/shared y, al
 * aprobar, se congela en las columnas `invoice_total_*` de `shipments` (que es lo
 * que consume la guarda Condition.RequiresInvoiceAmount de la maquina de estados).
 *
 * Nota sobre el tipo numerico: se usa `doublePrecision` por coherencia con
 * `client_rates.price_per_kg` y `cost_services.default_value` (regla M1 es una
 * advertencia, no bloqueante). Todo redondeo pasa por `roundMoney`/`convertMoney`
 * de @courier/shared, que son el punto unico de la politica (regla M4).
 */
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { COST_LINE_SOURCE_VALUES } from '@courier/shared';
import { currencyEnum } from '../../core/currency.schema';
import { users } from '../auth/auth.schema';
import { costServices } from '../cost-services/cost-service.schema';
import { shipments } from '../shipments/shipments.schema';

export const costLineSourceEnum = pgEnum('cost_line_source', COST_LINE_SOURCE_VALUES);

export const shipmentCosts = pgTable(
  'shipment_costs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    /** Servicio del catalogo del que salio la linea; null en el flete. */
    costServiceId: uuid('cost_service_id').references(() => costServices.id, { onDelete: 'set null' }),
    /** Etiqueta congelada al cargar: nunca se relee del catalogo. */
    label: text('label').notNull(),
    source: costLineSourceEnum('source').notNull(),
    /** Porcentaje aplicado (0-100) cuando source = percentage; null en el resto. */
    percentage: doublePrecision('percentage'),
    /** Importe ya resuelto de la linea. Siempre >= 0 (lo acota el servicio, regla M3). */
    amount: doublePrecision('amount').notNull(),
    /** Moneda del importe, explicita (regla M2). */
    currency: currencyEnum('currency').notNull(),
    /** Colones por 1 USD al cargar el costo (regla M5). Obligatoria, siempre > 0. */
    exchangeRate: doublePrecision('exchange_rate').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shipment_costs_shipment_idx').on(t.shipmentId, t.createdAt),
    /**
     * Las reglas de rango (M3) y de tasa presente y positiva (M5) tambien se
     * validan en Zod y en el servicio. Repetirlas aqui es deliberado: la BD es la
     * ultima linea, la unica que tambien cubre un script o una correccion manual.
     */
    check('shipment_costs_amount_nonneg', sql`${t.amount} >= 0`),
    check('shipment_costs_rate_positive', sql`${t.exchangeRate} > 0`),
    check(
      'shipment_costs_percentage_range',
      sql`${t.percentage} is null or (${t.percentage} >= 0 and ${t.percentage} <= 100)`,
    ),
  ],
);

export type ShipmentCostRow = typeof shipmentCosts.$inferSelect;
export type NewShipmentCostRow = typeof shipmentCosts.$inferInsert;
