/**
 * Acceso a datos de las tarifas preferenciales de cliente. La unicidad de nombre
 * se comprueba case-insensitive (ilike) ademas del UNIQUE de la BD. Las
 * operaciones que tocan el invariante "un solo default" y el borrado con
 * reasignacion corren en transaccion.
 */
import { and, count, eq, ilike, ne } from 'drizzle-orm';
import { db } from '../../core/db';
import { clients } from '../auth/auth.schema';
import { clientRates } from './tariffs.schema';

const columns = {
  id: clientRates.id,
  name: clientRates.name,
  pricePerKg: clientRates.pricePerKg,
  currency: clientRates.currency,
  isDefault: clientRates.isDefault,
  allowsCard: clientRates.allowsCard,
  allowsBankDeposit: clientRates.allowsBankDeposit,
};

export const tariffsRepo = {
  /** Lista todas las tarifas ordenadas por precio (mayor a menor). */
  async list() {
    return db.select(columns).from(clientRates).orderBy(clientRates.pricePerKg);
  },

  async findById(id: string) {
    const [row] = await db.select(columns).from(clientRates).where(eq(clientRates.id, id)).limit(1);
    return row ?? null;
  },

  /** Tarifa marcada como por defecto (deberia existir siempre una). */
  async findDefault() {
    const [row] = await db.select(columns).from(clientRates).where(eq(clientRates.isDefault, true)).limit(1);
    return row ?? null;
  },

  /** True si existe otra tarifa con ese nombre (case-insensitive), excluyendo `exceptId`. */
  async nameTaken(name: string, exceptId?: string) {
    const conds = [ilike(clientRates.name, name)];
    if (exceptId) conds.push(ne(clientRates.id, exceptId));
    const [row] = await db.select({ id: clientRates.id }).from(clientRates).where(and(...conds)).limit(1);
    return Boolean(row);
  },

  /** Cuantas tarifas hay en total (para forzar default en la primera). */
  async count() {
    const [row] = await db.select({ n: count() }).from(clientRates);
    return row?.n ?? 0;
  },

  /** Cuantos casilleros tienen asignada esta tarifa. */
  async countClientsByRate(rateId: string): Promise<number> {
    const [row] = await db.select({ n: count() }).from(clients).where(eq(clients.clientRateId, rateId));
    return row?.n ?? 0;
  },

  /** Reasigna a la tarifa por defecto todos los casilleros de `fromRateId`. */
  async reassignClientsToDefault(fromRateId: string, defaultRateId: string): Promise<void> {
    await db
      .update(clients)
      .set({ clientRateId: defaultRateId })
      .where(eq(clients.clientRateId, fromRateId));
  },

  /** Inserta, garantizando el invariante de un solo default en una transaccion. */
  async insert(values: typeof clientRates.$inferInsert) {
    return db.transaction(async (tx) => {
      if (values.isDefault) {
        await tx.update(clientRates).set({ isDefault: false }).where(eq(clientRates.isDefault, true));
      }
      const [row] = await tx.insert(clientRates).values(values).returning(columns);
      if (!row) throw new Error('No se pudo crear la tarifa.');
      return row;
    });
  },

  /** Actualiza; si promueve a default, primero desmarca la anterior (transaccion). */
  async update(id: string, patch: Partial<typeof clientRates.$inferInsert>) {
    return db.transaction(async (tx) => {
      if (patch.isDefault) {
        await tx
          .update(clientRates)
          .set({ isDefault: false })
          .where(and(eq(clientRates.isDefault, true), ne(clientRates.id, id)));
      }
      const [row] = await tx
        .update(clientRates)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(clientRates.id, id))
        .returning(columns);
      return row ?? null;
    });
  },

  /** Reasigna los casilleros asociados a la default y elimina la tarifa (transaccion). */
  async deleteAndReassign(id: string, defaultRateId: string) {
    await db.transaction(async (tx) => {
      // Reasignar y borrar van en la MISMA transaccion: si el borrado falla, los
      // casilleros no se quedan movidos a una tarifa que no les corresponde.
      await tx.update(clients).set({ clientRateId: defaultRateId }).where(eq(clients.clientRateId, id));
      await tx.delete(clientRates).where(eq(clientRates.id, id));
    });
  },
};
