/**
 * Tablas Drizzle del cobro: los abonos de un tramite (`payments`) y el cobro de
 * una o varias proformas (`payment_groups`, al final del archivo).
 *
 * Van juntas porque se referencian entre si (`payments.group_id`) y separarlas en
 * dos modulos habria hecho un ciclo de imports por el enum del medio de pago.
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  BANK_ACCOUNT_VALUES,
  PAYMENT_METHOD_VALUES,
  PAYMENT_STATUS_VALUES,
  PaymentStatus,
} from '@courier/shared';
import { currencyEnum } from '../../core/currency.schema';
import { clients, users } from '../auth/auth.schema';
import { shipments } from '../shipments/shipments.schema';
import { clientRates } from '../tariffs/tariffs.schema';

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
    /**
     * RECARGO POR TARJETA cobrado ENCIMA del abono: la comision de la pasarela
     * trasladada al cliente (`cardChargeFor`). En la moneda y con la tasa de esta
     * misma fila, que son las del cobro (reglas M2 y M5).
     *
     * Columna aparte y no sumado en `amount` a proposito: lo que cancela la
     * factura es el abono, no el recargo. Metido dentro, el tramite aparecería
     * pagado de mas contra su propia factura y el reporte financiero contaria
     * como ingreso un dinero que se queda en la pasarela. Lo que se le cobro a la
     * tarjeta es la suma de los dos.
     *
     * CERO en todo lo que no sea tarjeta (un deposito no genera comision) y en
     * los cobros anteriores a este recargo, que es justo lo que dice el default.
     */
    surchargeAmount: doublePrecision('surcharge_amount').notNull().default(0),
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

    /**
     * COBRO al que pertenece este abono: el pago de una o varias proformas crea
     * un grupo y un abono por cada tramite. Null solo en abonos anteriores al
     * modulo de proformas (pago tramite por tramite).
     *
     * El abono sigue siendo del TRAMITE, no del grupo: eso es lo que deja intacto
     * a `isSettled` y a todo lo que pregunta si un paquete esta pagado. El grupo
     * solo dice que este abono se cobro junto con otros y en un solo movimiento.
     */
    groupId: uuid('group_id').references(() => paymentGroups.id, { onDelete: 'set null' }),

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
    /** Los abonos de un cobro de proformas: los pide el webhook y la validacion del cobro. */
    index('payments_group_idx').on(t.groupId),
    /**
     * Referencia de la pasarela: es la unica llave que trae el webhook de Onvo
     * (`findByGatewayReference`), y Onvo REINTENTA las entregas fallidas, asi que
     * sin indice cada reintento barria la tabla de pagos entera.
     *
     * Unico y parcial (solo las filas que la tienen): los abonos por deposito la
     * dejan nula y no deben competir por el unico. Ademas de la lectura, el unico
     * respalda el supuesto del que ya depende `resolveIfPending`: una referencia
     * de la pasarela identifica UN abono, nunca dos.
     */
    uniqueIndex('payments_gateway_reference_idx')
      .on(t.gatewayReference)
      .where(sql`${t.gatewayReference} is not null`),
    /**
     * Las reglas de rango (M3) y de tasa presente y positiva (M5) tambien se
     * validan en Zod y en el servicio. Repetirlas aqui es deliberado: la BD es la
     * ultima linea, la unica que tambien cubre un script o una correccion manual.
     */
    check('payments_amount_nonneg', sql`${t.amount} >= 0`),
    check('payments_surcharge_nonneg', sql`${t.surchargeAmount} >= 0`),
    check('payments_rate_positive', sql`${t.exchangeRate} > 0`),
  ],
);

export type PaymentRow = typeof payments.$inferSelect;
export type NewPaymentRow = typeof payments.$inferInsert;

/**
 * Tabla Drizzle del COBRO DE PROFORMAS (`payment_groups`).
 *
 * Una fila = un pago (tarjeta o deposito) que salda una o varias proformas
 * completas de un casillero. Los abonos siguen estando en `payments`, uno por
 * tramite, apuntando aqui con `group_id`.
 *
 * POR QUE UNA TABLA Y NO SOLO UN `group_id` SUELTO EN `payments`. Por dos datos
 * que son del grupo y de ningun abono en particular:
 *
 *   1. LA REFERENCIA DE LA PASARELA. El cobro con tarjeta es UNO por el total, no
 *      uno por tramite. `payments.gateway_reference` tiene un unico parcial —una
 *      referencia identifica un abono, y de eso depende la idempotencia del
 *      webhook—, asi que repetirla en las cinco filas del grupo era imposible y
 *      quitarle el unico habria aflojado justo la garantia que evita aplicar dos
 *      veces un cobro reintentado.
 *   2. EL TOTAL Y LA COMISION DEL COBRO. Son del pago entero (la tarjeta cobra
 *      una sola comision), no de ninguno de sus abonos.
 *
 * La SITUACION del grupo no se guarda: se deriva de sus abonos
 * (`paymentGroupStatus`), por la misma razon por la que "pagado" no es una
 * columna del tramite. Un flag aqui podria contradecir a las filas que representa.
 */
export const paymentGroups = pgTable(
  'payment_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Casillero al que se le cobra. El grupo es de un cliente, no de un tramite. */
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    /**
     * HISTORICO: tarifa consolidada con la que se armaba el cobro agrupado de
     * antes. Los cobros de proformas la dejan en null.
     */
    clientRateId: uuid('client_rate_id').references(() => clientRates.id, { onDelete: 'set null' }),
    method: paymentMethodEnum('method').notNull(),

    /** Total cobrado por el grupo. Siempre >= 0 (regla M3, con CHECK abajo). */
    amount: doublePrecision('amount').notNull(),
    /**
     * RECARGO POR TARJETA del cobro, encima del total. Vive AQUI y no
     * repartido entre los abonos porque la comision es UNA, la del unico cargo
     * que pasa por la tarjeta; prorratearla entre los paquetes habria dejado
     * centimos sueltos que no cuadran con lo que cobro la pasarela.
     */
    surchargeAmount: doublePrecision('surcharge_amount').notNull().default(0),
    /** Moneda del total, explicita (regla M2). */
    currency: currencyEnum('currency').notNull(),
    /** Colones por 1 USD congelados al crear el grupo (regla M5). Siempre > 0. */
    exchangeRate: doublePrecision('exchange_rate').notNull(),

    /** Referencia del intento en la pasarela. Solo tarjeta; el deposito la deja nula. */
    gatewayReference: text('gateway_reference'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_groups_client_idx').on(t.clientId, t.createdAt),
    /**
     * Mismo motivo que en `payments`: es la unica llave que trae el webhook y Onvo
     * reintenta las entregas fallidas. Unico y parcial (los depositos la dejan
     * nula y no compiten por el unico).
     */
    uniqueIndex('payment_groups_gateway_reference_idx')
      .on(t.gatewayReference)
      .where(sql`${t.gatewayReference} is not null`),
    check('payment_groups_amount_nonneg', sql`${t.amount} >= 0`),
    check('payment_groups_surcharge_nonneg', sql`${t.surchargeAmount} >= 0`),
    check('payment_groups_rate_positive', sql`${t.exchangeRate} > 0`),
  ],
);

export type PaymentGroupRow = typeof paymentGroups.$inferSelect;
export type NewPaymentGroupRow = typeof paymentGroups.$inferInsert;
