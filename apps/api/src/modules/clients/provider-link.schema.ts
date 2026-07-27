/**
 * Bitacora del enlace de un casillero con el proveedor (Helga).
 *
 * Las columnas `helga_*` de `clients` guardan el ULTIMO estado del enlace, que es
 * lo que necesita el login y la reconciliacion. Pero el ultimo estado no explica
 * como se llego ahi: un casillero en 'failed' con 40 intentos y un casillero que
 * fallo una vez se ven identicos, y un enlace corregido a mano no deja rastro de
 * quien lo toco ni por que.
 *
 * Esta tabla es el historial. Append-only: nunca se actualiza ni se borra, igual
 * que `shipment_events`. Cada intento (automatico o manual) escribe una fila.
 *
 * Existe porque un cliente que Helga rechaza NO PUEDE ENTRAR AL PORTAL (la puerta
 * del login exige `synced`), asi que soporte necesita ver el motivo real y poder
 * corregirlo, no solo saber que "falló".
 */
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { HELGA_SYNC_STATUS_VALUES, PROVIDER_LINK_SOURCE_VALUES } from '@courier/shared';
import { clients, helgaSyncStatusEnum, users } from '../auth/auth.schema';

/** Que origino el evento: el robot, el alta del cliente o una correccion manual. */
export const providerLinkSourceEnum = pgEnum(
  'provider_link_source',
  PROVIDER_LINK_SOURCE_VALUES,
);

export const clientProviderLinkEvents = pgTable(
  'client_provider_link_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    source: providerLinkSourceEnum('source').notNull(),
    /** Estado del enlace DESPUES del evento. */
    status: helgaSyncStatusEnum('status').notNull(),
    /** Mensaje del proveedor, o la nota que escribio quien corrigio a mano. */
    detail: text('detail'),
    /**
     * Campos del enlace que cambiaron, como `{ campo: { de, a } }`. Es el diff, no
     * la fila entera: guardar el estado completo en cada evento haria ilegible lo
     * unico que importa (que se movio). `jsonb` porque el conjunto de campos puede
     * crecer y no vale la pena una columna por cada uno.
     */
    changes: jsonb('changes').$type<Record<string, { from: string | null; to: string | null }>>(),
    /** Quien lo hizo; null = el robot (no hay persona detras). */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('client_provider_link_events_client_idx').on(t.clientId, t.createdAt)],
);

export type ClientProviderLinkEventRow = typeof clientProviderLinkEvents.$inferSelect;
