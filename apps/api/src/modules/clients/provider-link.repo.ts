/**
 * Acceso a datos del enlace de casilleros con el proveedor: el listado del panel,
 * la bitacora y la escritura de ambos.
 *
 * Las columnas `helga_*` viven en `clients` (tabla del modulo auth). Este modulo
 * las ESCRIBE, a diferencia del resto de `clients.repo`, que solo lee lo de auth:
 * la correccion manual del enlace es una funcion del panel de administracion, y
 * ponerla en auth mezclaria el alta de cuentas con la operacion diaria.
 */
import { and, count, desc, eq, inArray, ilike, ne, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { HelgaSyncStatus, toSlice } from '@courier/shared';
import type { ListProviderLinksQuery, ProviderLinkSource } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { clientProviderLinkEvents } from './provider-link.schema';

/** Los que NO estan enlazados: el caso de uso por defecto del panel. */
const UNLINKED = [HelgaSyncStatus.Pending, HelgaSyncStatus.Failed] as [
  HelgaSyncStatus,
  ...HelgaSyncStatus[],
];

const linkColumns = {
  clientId: clients.id,
  clientCode: clients.code,
  name: users.name,
  email: users.email,
  idNumber: clients.idNumber,
  status: clients.helgaSyncStatus,
  helgaClientId: clients.helgaClientId,
  subLocker: clients.helgaSubLocker,
  attempts: clients.helgaSyncAttempts,
  lastError: clients.helgaLastError,
  syncedAt: clients.helgaSyncedAt,
  createdAt: clients.createdAt,
};

/**
 * Filtros del panel, en SQL. Sin filtro de estado se acota a los NO enlazados: el
 * panel existe para atender problemas, y arrancar mostrando los miles de
 * casilleros sanos esconderia los pocos que importan.
 */
function listConditions(query: ListProviderLinksQuery): SQL[] {
  const conds: SQL[] = [
    query.status
      ? eq(clients.helgaSyncStatus, query.status)
      : inArray(clients.helgaSyncStatus, UNLINKED),
  ];

  if (query.q) {
    const term = `%${query.q}%`;
    const match = or(
      ilike(clients.code, term),
      ilike(users.name, term),
      ilike(users.email, term),
      ilike(clients.idNumber, term),
    );
    if (match) conds.push(match);
  }

  return conds;
}

export const providerLinkRepo = {
  /** Una PAGINA del listado del panel. */
  async list(query: ListProviderLinksQuery) {
    const { limit, offset } = toSlice(query);
    return db
      .select(linkColumns)
      .from(clients)
      .innerJoin(users, eq(clients.userId, users.id))
      .where(and(...listConditions(query)))
      /**
       * Los que mas veces fallaron primero: son los que no se van a arreglar
       * solos. `id` cierra la clave porque los intentos empatan casi siempre (la
       * mayoria estan en 0 o 1) y un orden ambiguo repite filas al paginar.
       */
      .orderBy(desc(clients.helgaSyncAttempts), desc(clients.createdAt), desc(clients.id))
      .limit(limit)
      .offset(offset);
  },

  /** Cuantos casilleros hay con ese filtro. */
  async countList(query: ListProviderLinksQuery) {
    const [row] = await db
      .select({ n: count() })
      .from(clients)
      .innerJoin(users, eq(clients.userId, users.id))
      .where(and(...listConditions(query)));
    return row?.n ?? 0;
  },

  /**
   * Cuantos de los que trae el filtro NO estan enlazados. Es el numero que el
   * servicio convierte en "sin poder ingresar al portal", y se cuenta sobre el
   * filtro completo y no sobre la pagina: contando la pagina, un panel con
   * treinta clientes encerrados diria tres.
   */
  async countUnsynced(query: ListProviderLinksQuery) {
    const conds = [
      ...listConditions(query),
      ne(clients.helgaSyncStatus, HelgaSyncStatus.Synced),
    ];
    const [row] = await db
      .select({ n: count() })
      .from(clients)
      .innerJoin(users, eq(clients.userId, users.id))
      .where(and(...conds));
    return row?.n ?? 0;
  },

  /** Un enlace por casillero. */
  async findByClientId(clientId: string) {
    const [row] = await db
      .select(linkColumns)
      .from(clients)
      .innerJoin(users, eq(clients.userId, users.id))
      .where(eq(clients.id, clientId))
      .limit(1);
    return row ?? null;
  },

  /** Bitacora completa de un casillero, del evento mas reciente al mas antiguo. */
  async listEvents(clientId: string) {
    return db
      .select({
        id: clientProviderLinkEvents.id,
        source: clientProviderLinkEvents.source,
        status: clientProviderLinkEvents.status,
        detail: clientProviderLinkEvents.detail,
        changes: clientProviderLinkEvents.changes,
        createdByName: users.name,
        createdAt: clientProviderLinkEvents.createdAt,
      })
      .from(clientProviderLinkEvents)
      .leftJoin(users, eq(clientProviderLinkEvents.createdBy, users.id))
      .where(eq(clientProviderLinkEvents.clientId, clientId))
      .orderBy(desc(clientProviderLinkEvents.createdAt));
  },

  /**
   * Agrega un evento a la bitacora. Se llama desde el alta, la reconciliacion y la
   * correccion manual: los tres caminos que pueden mover el enlace.
   *
   * NUNCA lanza. La bitacora es para diagnostico: si fallara al escribirla, tumbar
   * el registro de un cliente (o abortar una pasada del robot) cambiaria un
   * problema de observabilidad por uno de negocio.
   */
  async addEvent(event: {
    clientId: string;
    source: ProviderLinkSource;
    status: HelgaSyncStatus;
    detail?: string | null;
    changes?: Record<string, { from: string | null; to: string | null }> | null;
    createdBy?: string | null;
  }): Promise<void> {
    try {
      await db.insert(clientProviderLinkEvents).values({
        clientId: event.clientId,
        source: event.source,
        status: event.status,
        detail: event.detail ?? null,
        changes: event.changes ?? null,
        createdBy: event.createdBy ?? null,
      });
    } catch (err) {
      console.error(`[provider-link] no se pudo registrar el evento de ${event.clientId}:`, err);
    }
  },

  /**
   * Escribe los campos del enlace. `undefined` deja la columna como esta; `null`
   * la limpia. Esa distincion es la que permite deshacer una correccion.
   */
  async updateLink(
    clientId: string,
    patch: {
      helgaSyncStatus?: HelgaSyncStatus;
      helgaClientId?: string | null;
      helgaSubLocker?: string | null;
      helgaSyncedAt?: Date | null;
      helgaLastError?: string | null;
    },
  ): Promise<void> {
    await db.update(clients).set(patch).where(eq(clients.id, clientId));
  },
};
