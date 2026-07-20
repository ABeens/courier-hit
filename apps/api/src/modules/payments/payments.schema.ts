/**
 * Tabla Drizzle de los pagos de un tramite (`payments`).
 *
 * Una fila = un abono. Append-only en la practica: lo unico que muta es el
 * `status` (pendiente -> confirmado/rechazado) y su sello de quien y cuando. El
 * monto, la moneda y la tasa son un SNAPSHOT y no se editan: corregir un pago
 * mal digitado se hace rechazandolo y registrando otro, para que el rastro quede.
 *
 * Cubre los dos requerimientos de pago del manual con una sola tabla:
 *   - el cliente paga desde el portal (tarjeta / deposito con comprobante);
 *   - el staff registra la "Informacion de Pago" de un tramite manual
 *     (docs/manuales/flujo.md L84-88: cuenta, comprobante, fecha, monto).
 *
 * Nota sobre el tipo numerico: `doublePrecision` por coherencia con
 * `shipment_costs.amount` (regla M1 es advertencia, no bloqueante). Todo redondeo
 * pasa por `roundMoney`/`convertMoney` de @courier/shared (regla M4).
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
import {
  BANK_ACCOUNT_VALUES,
  PAYMENT_METHOD_VALUES,
  PAYMENT_STATUS_VALUES,
  PaymentStatus,
} from '@courier/shared';
import { currencyEnum } from '../../core/currency.schema';
import { users } from '../auth/auth.schema';
import { shipments } from '../shipments/shipments.schema';

export const paymentMethodEnum = pgEnum('payment_method', PAYMENT_METHOD_VALUES);
export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUS_VALUES);
export const bankAccountEnum = pgEnum('bank_account', BANK_ACCOUNT_VALUES);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    method: paymentMethodEnum('method').notNull(),
    /**
     * Nace pendiente: subir un comprobante no es cobrar. Lo mueve a confirmado el
     * staff (deposito) o la pasarela (tarjeta).
     */
    status: paymentStatusEnum('status').notNull().default(PaymentStatus.Pendiente),

    /** Monto abonado. Siempre >= 0 (regla M3, ademas con CHECK abajo). */
    amount: doublePrecision('amount').notNull(),
    /** Moneda del monto, explicita (regla M2). */
    currency: currencyEnum('currency').notNull(),
    /** Colones por 1 USD al registrar el pago (regla M5). Obligatoria, siempre > 0. */
    exchangeRate: doublePrecision('exchange_rate').notNull(),

    // --- Solo deposito bancario (la "Informacion de Pago" del manual) ---
    bankAccount: bankAccountEnum('bank_account'),
    receiptNumber: text('receipt_number'),
    depositedAt: timestamp('deposited_at', { withTimezone: true }),
    /** Clave del comprobante en el almacen de archivos (core/storage). */
    receiptFileKey: text('receipt_file_key'),

    // --- Solo tarjeta ---
    /**
     * Referencia de la pasarela (Onvo Pay). Es el enlace con el cobro real:
     * nuestro `id` de un lado, el suyo del otro.
     */
    gatewayReference: text('gateway_reference'),

    note: text('note'),
    /** Quien lo registro: el propio cliente o un usuario de staff. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payments_shipment_idx').on(t.shipmentId, t.createdAt),
    /** Bandeja de validacion del staff: "los depositos pendientes". */
    index('payments_status_idx').on(t.status),
    /**
     * Las reglas de rango (M3) y de tasa presente y positiva (M5) tambien se
     * validan en Zod y en el servicio. Repetirlas aqui es deliberado: la BD es la
     * ultima linea, la unica que tambien cubre un script o una correccion manual.
     */
    check('payments_amount_nonneg', sql`${t.amount} >= 0`),
    check('payments_rate_positive', sql`${t.exchangeRate} > 0`),
  ],
);

export type PaymentRow = typeof payments.$inferSelect;
export type NewPaymentRow = typeof payments.$inferInsert;
