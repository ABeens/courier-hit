/**
 * Tablas Drizzle del modulo de tramites: `shipments` (la entidad central) y
 * `shipment_events` (su historial de estados, append-only).
 *
 * Los enums salen de @courier/shared (fuente unica): asi la maquina de estados
 * de `workflow/` y el enum de Postgres no pueden divergir.
 *
 * Nota sobre docs/02b-base-de-datos.md §4.5: ese documento describe una tabla
 * `packages` con un enum `package_status` de 8 valores y los costos embebidos.
 * Quedo desactualizado frente a @courier/shared, que modela 5 tipos de tramite,
 * 3 maquinas de estado y 21 estados. Manda el dominio compartido.
 */
import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { SHIPMENT_TYPE_VALUES, STATE_VALUES } from '@courier/shared';
import { clients, helgaSyncStatusEnum, users } from '../auth/auth.schema';

export const shipmentTypeEnum = pgEnum('shipment_type', SHIPMENT_TYPE_VALUES);
export const shipmentStateEnum = pgEnum('shipment_state', STATE_VALUES);

/**
 * Secuencia del consecutivo de negocio. Arranca en 1000 para que el primer
 * tramite sea HS000001000, el ejemplo literal del manual (flujo.md L92).
 */
export const shipmentCodeSeq = pgSequence('hs_shipment_code_seq', { startWith: 1000, increment: 1 });

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Consecutivo `HS000001000` (clave de negocio, nunca se usa como FK). */
    code: text('code').notNull().unique(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    shipmentType: shipmentTypeEnum('shipment_type').notNull(),
    /**
     * Estado actual. El flow NO se guarda: se deriva del tipo con `flowForType`.
     * Persistirlo permitiria que tipo y flow se desincronizaran.
     */
    state: shipmentStateEnum('state').notNull(),
    /** Tracking (Paqueteria) o AWB/BL (Transporte y Agenciamiento). */
    tracking: text('tracking').notNull(),
    description: text('description').notNull(),

    // --- Solo Paqueteria ---
    store: text('store'),
    carrier: text('carrier'),
    hawb: text('hawb'),
    /** Peso en kilos, entero: se redondea hacia arriba al guardar (flujo.md L115). */
    weightKg: integer('weight_kg'),

    // --- Solo Transporte y Agenciamiento ---
    warehouse: text('warehouse'),
    dua: text('dua'),
    billingNotes: text('billing_notes'),

    // --- Snapshot de la factura (se congela al APROBAR los costos) ---
    /**
     * Total aprobado, congelado en AMBAS monedas (regla M2: nunca una cifra sin
     * moneda). Se derivan de las lineas de `shipment_costs` con `computeTotals`,
     * cada una con su propia tasa; aqui quedan como el monto de factura que
     * exige la guarda Condition.RequiresInvoiceAmount para pasar a
     * "En bodega - Pendiente pago". Null mientras no se haya aprobado.
     */
    invoiceTotalUsd: doublePrecision('invoice_total_usd'),
    invoiceTotalCrc: doublePrecision('invoice_total_crc'),
    costsApprovedAt: timestamp('costs_approved_at', { withTimezone: true }),
    costsApprovedBy: uuid('costs_approved_by').references(() => users.id, { onDelete: 'set null' }),

    // --- Replicacion de la prealerta ante el proveedor (Helga) ---
    /**
     * Estado de la replicacion de esta prealerta en Helga. Reusa el enum del
     * casillero (`helga_sync_status`). `null` = no aplica (solo Paqueteria se
     * prealerta). Nace 'pending'; el intento inmediato la deja 'synced' o
     * 'failed', y si el casillero aun no esta enlazado queda 'pending' para que
     * la reconciliacion la reenvie. La misma red que el casillero, pero por
     * tramite. Nota: si nunca se replica, la sincronizacion por tracking la
     * recupera igual cuando el paquete llega a bodega (no es load-bearing).
     */
    helgaPrealertStatus: helgaSyncStatusEnum('helga_prealert_status'),
    /** Intentos de replicacion ya realizados; 0 si nunca se intento. */
    helgaPrealertAttempts: integer('helga_prealert_attempts').notNull().default(0),
    /** Ultimo error del proveedor al replicar; para diagnostico de la reconciliacion. */
    helgaPrealertError: text('helga_prealert_error'),

    /** Quien lo dio de alta: el propio cliente (prealerta) o un usuario de staff. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shipments_client_idx').on(t.clientId), // "mis paquetes"
    index('shipments_state_idx').on(t.state), // colas de bodega / entrega
    index('shipments_created_at_idx').on(t.createdAt), // filtro por rango de fechas
    /**
     * Un mismo tracking no puede estar activo dos veces, pero SI puede repetirse
     * historicamente (los transportistas reciclan numeros de guia). Por eso el
     * indice unico es PARCIAL: solo aplica a los tramites que aun no terminaron.
     */
    uniqueIndex('shipments_active_tracking')
      .on(t.tracking)
      .where(sql`${t.state} <> 'entregado'`),
  ],
);

/**
 * Historial de estados. Append-only: nunca se actualiza ni se borra. Cada alta
 * escribe su primer evento (Prealertado) y cada avance agrega uno.
 */
export const shipmentEvents = pgTable(
  'shipment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    state: shipmentStateEnum('state').notNull(),
    /** Comentario del evento (obligatorio al devolver a bodega: Condition.RequiresComment). */
    note: text('note'),
    /** Quien lo disparo; null = el sistema (p. ej. sincronizacion con el proveedor). */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('shipment_events_shipment_idx').on(t.shipmentId, t.createdAt)],
);

export type ShipmentRow = typeof shipments.$inferSelect;
export type NewShipmentRow = typeof shipments.$inferInsert;
export type ShipmentEventRow = typeof shipmentEvents.$inferSelect;
