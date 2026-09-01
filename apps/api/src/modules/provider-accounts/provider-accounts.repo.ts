/**
 * Lecturas y escrituras de las cuentas exclusivas del proveedor.
 *
 * La tabla es diminuta por naturaleza (una fila por empresa consolidada, se
 * cuentan con los dedos), asi que aqui no hay paginacion ni indices de busqueda:
 * el listado se trae entero y el panel lo pinta entero.
 */
import { eq, getTableColumns } from 'drizzle-orm';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import type { NewProviderAccountRow, ProviderAccountRow } from './provider-accounts.schema';
import { providerAccounts } from './provider-accounts.schema';

/** La cuenta con los datos del cliente consolidado ya resueltos, para el panel. */
export interface ProviderAccountWithClient {
  account: ProviderAccountRow;
  client: { id: string; code: string; name: string; email: string } | null;
}

/** Las columnas de la tabla, para poder mezclarlas con las del join. */
const accountColumns = getTableColumns(providerAccounts);

/**
 * Columnas del cliente que el panel muestra junto a la cuenta. El `left join` es
 * obligatorio y no un `inner`: una cuenta recien creada todavia no tiene cliente
 * (primero se capturan las credenciales, despues se da de alta al titular).
 */
const clientColumns = {
  clientId: clients.id,
  clientCode: clients.code,
  clientName: users.name,
  clientEmail: users.email,
};

function toWithClient(row: ProviderAccountRow & {
  clientId: string | null;
  clientCode: string | null;
  clientName: string | null;
  clientEmail: string | null;
}): ProviderAccountWithClient {
  const { clientId, clientCode, clientName, clientEmail, ...account } = row;
  return {
    account: account as ProviderAccountRow,
    client:
      clientId && clientCode
        ? { id: clientId, code: clientCode, name: clientName ?? '', email: clientEmail ?? '' }
        : null,
  };
}

export const providerAccountsRepo = {
  /** Todas las cuentas, activas y apagadas, de la mas antigua a la mas nueva. */
  async list(): Promise<ProviderAccountWithClient[]> {
    const rows = await db
      .select({ ...accountColumns, ...clientColumns })
      .from(providerAccounts)
      .leftJoin(clients, eq(providerAccounts.consolidatedClientId, clients.id))
      .leftJoin(users, eq(clients.userId, users.id))
      .orderBy(providerAccounts.createdAt);
    return rows.map(toWithClient);
  },

  async findById(id: string): Promise<ProviderAccountWithClient | null> {
    const rows = await db
      .select({ ...accountColumns, ...clientColumns })
      .from(providerAccounts)
      .leftJoin(clients, eq(providerAccounts.consolidatedClientId, clients.id))
      .leftJoin(users, eq(clients.userId, users.id))
      .where(eq(providerAccounts.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toWithClient(row) : null;
  },

  async findByCode(code: string): Promise<ProviderAccountRow | null> {
    const rows = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.code, code))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * La cuenta exclusiva de un cliente, si la tiene. Es la pregunta "¿este cliente
   * es consolidado?", y la hace todo camino que se comporta distinto para ellos
   * (la replicacion de prealertas, sin ir mas lejos).
   */
  async findByClientId(clientId: string): Promise<ProviderAccountRow | null> {
    const rows = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.consolidatedClientId, clientId))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Las cuentas que entran en el recorrido de importacion: activas y CON cliente
   * consolidado. Una cuenta sin cliente se salta a proposito, porque no habria a
   * quien atribuirle sus paquetes; el panel la muestra como incompleta.
   */
  async listImportable(): Promise<ProviderAccountRow[]> {
    const rows = await db.select().from(providerAccounts).orderBy(providerAccounts.createdAt);
    return rows.filter((r) => r.active && r.consolidatedClientId !== null);
  },

  async insert(row: NewProviderAccountRow): Promise<ProviderAccountRow> {
    const [created] = await db.insert(providerAccounts).values(row).returning();
    return created as ProviderAccountRow;
  },

  async update(
    id: string,
    patch: Partial<NewProviderAccountRow>,
  ): Promise<ProviderAccountRow | null> {
    const [updated] = await db
      .update(providerAccounts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(providerAccounts.id, id))
      .returning();
    return updated ?? null;
  },

  /**
   * Sella el resultado de la ultima corrida de importacion.
   *
   * No pasa por `update` para no tocar `updated_at`: esa columna cuenta cuando la
   * EDITO una persona, y el robot escribiendo cada pocos minutos la volveria
   * inservible para eso.
   */
  async markImport(id: string, error: string | null): Promise<void> {
    await db
      .update(providerAccounts)
      .set({ lastImportAt: new Date(), lastImportError: error })
      .where(eq(providerAccounts.id, id));
  },
};
