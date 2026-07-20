/**
 * Tabla Drizzle de los intentos de entrega (`delivery_attempts`).
 *
 * Append-only: una fila por visita del mensajero, nunca se actualiza ni se borra.
 * El estado del tramite es la CONSECUENCIA del intento (lo mueve el servicio con
 * `stateForOutcome`), no un campo de aqui: duplicarlo permitiria que el intento
 * dijera "entregado" y el tramite otra cosa.
 *
 * Fuente: "Requerimientos Parte 5 - Portal Entregas" y docs/14-modulo-entregas.md.
 */
import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { DELIVERY_OUTCOME_VALUES } from '@courier/shared';
import { users } from '../auth/auth.schema';
import { shipments } from '../shipments/shipments.schema';

export const deliveryOutcomeEnum = pgEnum('delivery_outcome', DELIVERY_OUTCOME_VALUES);

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    outcome: deliveryOutcomeEnum('outcome').notNull(),
    /**
     * Foto del paquete entregado, en el almacen de archivos (core/storage).
     * Obligatoria cuando outcome = entregado; la exige el servicio, no la BD,
     * porque la regla es condicional al desenlace (`proofRequirementFor`).
     */
    photoFileKey: text('photo_file_key'),
    /** Razon de la devolucion. Obligatoria cuando outcome = devuelto_bodega. */
    note: text('note'),
    /** Mensajero que hizo la visita. */
    courierId: uuid('courier_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('delivery_attempts_shipment_idx').on(t.shipmentId, t.createdAt)],
);

export type DeliveryAttemptRow = typeof deliveryAttempts.$inferSelect;
export type NewDeliveryAttemptRow = typeof deliveryAttempts.$inferInsert;
