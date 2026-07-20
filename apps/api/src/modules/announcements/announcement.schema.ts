/**
 * Tabla Drizzle de los anuncios manuales (docs/manuales/roles.md §3).
 *
 * NO hay columna `status`: Activo / Programado / Vencido / Inactivo se derivan
 * de `enabled` + la vigencia contra el instante actual (announcementStatus en
 * @courier/shared). Una columna asi quedaria desactualizada en cuanto pasara la
 * fecha y obligaria a un job de expiracion; derivarla hace que el anuncio caduque
 * solo (§3.4.5).
 *
 * Audiencia: en esta iteracion todo anuncio aplica a TODOS los clientes (§3.3.4),
 * asi que no hay columna de segmentacion todavia.
 */
import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { ANNOUNCEMENT_TYPE_VALUES } from '@courier/shared';

export const announcementTypeEnum = pgEnum('announcement_type', ANNOUNCEMENT_TYPE_VALUES);

export const announcements = pgTable(
  'announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    type: announcementTypeEnum('type').notNull(),
    /** Vigencia en UTC (regla del repo: se almacena UTC, se muestra en local). */
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** Interruptor manual del admin. Independiente de la vigencia. */
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // El portal consulta "vigentes ahora" en cada carga: es la query caliente.
    index('announcements_live_idx').on(t.enabled, t.startsAt, t.endsAt),
  ],
);

export type AnnouncementRow = typeof announcements.$inferSelect;
export type NewAnnouncementRow = typeof announcements.$inferInsert;
