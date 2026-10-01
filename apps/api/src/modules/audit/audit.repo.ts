/**
 * Acceso a datos de la auditoria. Lee el historial de tramites (`shipment_events`)
 * y se queda con los asientos de correccion: los que llevan `CORRECTION_NOTE_PREFIX`
 * (ver `@courier/shared`, `audit/dto`). No escribe nada.
 *
 * El dueño entra con LEFT JOIN porque un paquete registrado sin dueño sigue sin
 * uno, y su alta tambien es una correccion que hay que poder auditar.
 */
import { and, count, desc, eq, gte, ilike, lt, notLike, like, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { CORRECTION_KIND_PATTERNS, CORRECTION_NOTE_PREFIX, CorrectionKind, toSlice } from '@courier/shared';
import type { ListCorrectionsQuery, State } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { shipmentEvents, shipments } from '../shipments/shipments.schema';

/** Quien corrigio y el titular del casillero son dos filas distintas de `users`. */
const author = alias(users, 'author');
const owner = alias(users, 'owner');

/**
 * Estado del asiento ANTERIOR del mismo tramite: con el, la fila dice "de X a Y".
 * Subconsulta correlacionada y no `lag()`: una ventana obligaria a recorrer el
 * historial entero antes de filtrar, y esto solo se evalua para la pagina visible
 * (usa el indice `shipment_events_shipment_idx`).
 */
const previousState = sql<State | null>`(
  select prev.state from shipment_events prev
  where prev.shipment_id = ${shipmentEvents.shipmentId}
    and prev.created_at < ${shipmentEvents.createdAt}
  order by prev.created_at desc
  limit 1
)`;

const columns = {
  id: shipmentEvents.id,
  createdAt: shipmentEvents.createdAt,
  note: shipmentEvents.note,
  state: shipmentEvents.state,
  previousState,
  shipmentId: shipments.id,
  shipmentCode: shipments.code,
  tracking: shipments.tracking,
  shipmentType: shipments.shipmentType,
  clientCode: clients.code,
  clientName: owner.name,
  authorName: author.name,
};

/** LIKE de un tipo (con el prefijo delante). */
function kindPattern(kind: CorrectionKind): string | undefined {
  const rest = CORRECTION_KIND_PATTERNS[kind];
  return rest === undefined ? undefined : `${CORRECTION_NOTE_PREFIX}${rest}`;
}

function buildConditions(query: ListCorrectionsQuery): SQL[] {
  const conds: SQL[] = [like(shipmentEvents.note, `${CORRECTION_NOTE_PREFIX}%`)];

  if (query.kind) {
    const pattern = kindPattern(query.kind);
    if (pattern) {
      conds.push(like(shipmentEvents.note, pattern));
    } else {
      // `Estado` es "ninguno de los demas": su nota es solo el comentario.
      for (const kind of Object.values(CorrectionKind)) {
        const other = kindPattern(kind);
        if (other) conds.push(notLike(shipmentEvents.note, other));
      }
    }
  }

  // Inicio inclusive, fin exclusivo (la web manda el arranque del dia siguiente).
  if (query.from) conds.push(gte(shipmentEvents.createdAt, new Date(query.from)));
  if (query.to) conds.push(lt(shipmentEvents.createdAt, new Date(query.to)));

  if (query.q) {
    const term = `%${query.q}%`;
    const match = or(
      ilike(shipmentEvents.note, term),
      ilike(shipments.code, term),
      ilike(shipments.tracking, term),
      ilike(clients.code, term),
      ilike(owner.name, term),
      ilike(author.name, term),
    );
    if (match) conds.push(match);
  }
  return conds;
}

export const auditRepo = {
  /** Una pagina de correcciones, de la mas reciente a la mas antigua, y el total filtrado. */
  async listCorrections(query: ListCorrectionsQuery) {
    const where = and(...buildConditions(query));
    const { limit, offset } = toSlice(query);

    const [rows, [totalRow]] = await Promise.all([
      db
        .select(columns)
        .from(shipmentEvents)
        .innerJoin(shipments, eq(shipmentEvents.shipmentId, shipments.id))
        .leftJoin(clients, eq(shipments.clientId, clients.id))
        .leftJoin(owner, eq(clients.userId, owner.id))
        .leftJoin(author, eq(shipmentEvents.createdBy, author.id))
        .where(where)
        // Desempate por id: regla de `http/pagination` (orden determinista).
        .orderBy(desc(shipmentEvents.createdAt), desc(shipmentEvents.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(shipmentEvents)
        .innerJoin(shipments, eq(shipmentEvents.shipmentId, shipments.id))
        .leftJoin(clients, eq(shipments.clientId, clients.id))
        .leftJoin(owner, eq(clients.userId, owner.id))
        .leftJoin(author, eq(shipmentEvents.createdBy, author.id))
        .where(where),
    ]);

    return { rows, total: totalRow?.total ?? 0 };
  },
};
