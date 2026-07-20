/**
 * Acceso a datos de los anuncios.
 *
 * Dos consultas con proposito distinto:
 *   - `list`   : el listado del admin. Ve todo, incluso vencidos e inactivos.
 *   - `listLive`: lo que publica el portal. Filtra, ordena y RECORTA en SQL, de
 *     modo que el cliente jamas recibe un anuncio que no le toca ver.
 *
 * El estado no es una columna (ver announcement.schema.ts): el filtro por estado
 * se traduce aqui a condiciones sobre `enabled` + la vigencia contra `now()`. Se
 * usa el reloj de Postgres y no el de Node para que el corte sea uno solo aunque
 * corran varias instancias de la API con relojes ligeramente distintos.
 */
import { and, asc, count, desc, eq, gt, gte, ilike, lt, lte, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  ANNOUNCEMENT_TYPE_WEIGHT,
  ANNOUNCEMENT_VISIBLE_LIMIT,
  AnnouncementStatus,
  AnnouncementType,
} from '@courier/shared';
import type { ListAnnouncementsQuery } from '@courier/shared';
import { db } from '../../core/db';
import { announcements } from './announcement.schema';

const columns = {
  id: announcements.id,
  title: announcements.title,
  message: announcements.message,
  type: announcements.type,
  startsAt: announcements.startsAt,
  endsAt: announcements.endsAt,
  enabled: announcements.enabled,
  createdAt: announcements.createdAt,
  updatedAt: announcements.updatedAt,
};

/** Instante de corte: el reloj del servidor de base de datos. */
const NOW = sql`now()`;

/** Dentro de vigencia, con ambos extremos inclusivos. */
const inWindow = () => and(lte(announcements.startsAt, NOW), gte(announcements.endsAt, NOW));

/**
 * Traduce el estado derivado a condiciones SQL. Es la contraparte exacta de
 * `announcementStatus` de @courier/shared: si una cambia, la otra tambien.
 */
function statusCondition(status: AnnouncementStatus): SQL | undefined {
  switch (status) {
    case AnnouncementStatus.Inactivo:
      return eq(announcements.enabled, false);
    case AnnouncementStatus.Activo:
      return and(eq(announcements.enabled, true), inWindow());
    case AnnouncementStatus.Programado:
      return and(eq(announcements.enabled, true), gt(announcements.startsAt, NOW));
    case AnnouncementStatus.Vencido:
      return and(eq(announcements.enabled, true), lt(announcements.endsAt, NOW));
  }
}

/**
 * Peso de severidad como expresion SQL, generado desde el mapa compartido para
 * que el orden del portal no pueda divergir del que documenta el dominio.
 */
const severityRank = sql`case ${announcements.type} ${sql.join(
  (Object.keys(ANNOUNCEMENT_TYPE_WEIGHT) as AnnouncementType[]).map(
    (t) => sql`when ${t} then ${ANNOUNCEMENT_TYPE_WEIGHT[t]}`,
  ),
  sql` `,
)} else 0 end`;

export const announcementsRepo = {
  /** Listado del admin: busqueda en titulo/mensaje + filtros de tipo y estado. */
  async list(f: ListAnnouncementsQuery) {
    const conds: (SQL | undefined)[] = [];
    if (f.q) conds.push(or(ilike(announcements.title, `%${f.q}%`), ilike(announcements.message, `%${f.q}%`)));
    if (f.type) conds.push(eq(announcements.type, f.type));
    if (f.status) conds.push(statusCondition(f.status));
    const where = conds.filter(Boolean) as SQL[];
    return db
      .select(columns)
      .from(announcements)
      .where(where.length ? and(...where) : undefined)
      // Lo que se esta publicando primero, luego lo mas reciente.
      .orderBy(desc(severityRank), desc(announcements.createdAt));
  },

  /** Conteo publicandose ahora / total, para el encabezado de la pantalla. */
  async counts() {
    const [totalRow] = await db.select({ n: count() }).from(announcements);
    const [liveRow] = await db
      .select({ n: count() })
      .from(announcements)
      .where(and(eq(announcements.enabled, true), inWindow()));
    return { total: totalRow?.n ?? 0, live: liveRow?.n ?? 0 };
  },

  /**
   * Lo que ve el portal del cliente: habilitado Y vigente ahora (§3.3.5),
   * apilado por severidad y, a igual tipo, del mas reciente al mas antiguo
   * (§3.4.2). El LIMIT lo pone el servidor: los que sobran nunca salen de aqui.
   */
  async listLive() {
    return db
      .select({
        id: announcements.id,
        title: announcements.title,
        message: announcements.message,
        type: announcements.type,
        endsAt: announcements.endsAt,
      })
      .from(announcements)
      .where(and(eq(announcements.enabled, true), inWindow()))
      .orderBy(desc(severityRank), desc(announcements.createdAt))
      .limit(ANNOUNCEMENT_VISIBLE_LIMIT);
  },

  /** Instante en que el conjunto vigente cambia por si solo (el fin mas proximo). */
  async nextLiveExpiry(): Promise<Date | null> {
    const [row] = await db
      .select({ endsAt: announcements.endsAt })
      .from(announcements)
      .where(and(eq(announcements.enabled, true), inWindow()))
      .orderBy(asc(announcements.endsAt))
      .limit(1);
    return row?.endsAt ?? null;
  },

  async findById(id: string) {
    const [row] = await db.select(columns).from(announcements).where(eq(announcements.id, id)).limit(1);
    return row ?? null;
  },

  async insert(values: typeof announcements.$inferInsert) {
    const [row] = await db.insert(announcements).values(values).returning(columns);
    if (!row) throw new Error('No se pudo crear el anuncio.');
    return row;
  },

  async update(id: string, patch: Partial<typeof announcements.$inferInsert>) {
    const [row] = await db
      .update(announcements)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(announcements.id, id))
      .returning(columns);
    return row ?? null;
  },

  /**
   * Los anuncios SI se borran: a diferencia de usuarios o servicios de costo, no
   * cuelga trazabilidad de ellos y el spec pide la accion Borrar (§3.3.3).
   */
  async remove(id: string): Promise<boolean> {
    const rows = await db.delete(announcements).where(eq(announcements.id, id)).returning({ id: announcements.id });
    return rows.length > 0;
  },
};
