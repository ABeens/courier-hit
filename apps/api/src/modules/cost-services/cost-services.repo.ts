/**
 * Acceso a datos del catalogo de servicios de costo. La unicidad de nombre se
 * comprueba case-insensitive (ilike) ademas del UNIQUE de la BD.
 */
import { and, count, desc, eq, ilike, ne } from 'drizzle-orm';
import type { ListCostServicesQuery } from '@courier/shared';
import { db } from '../../core/db';
import { costServices } from './cost-service.schema';

const columns = {
  id: costServices.id,
  name: costServices.name,
  valueType: costServices.valueType,
  defaultValue: costServices.defaultValue,
  enabled: costServices.enabled,
  createdAt: costServices.createdAt,
  updatedAt: costServices.updatedAt,
};

export const costServicesRepo = {
  /** Lista con busqueda por nombre + filtros de tipo y habilitado. */
  async list(f: ListCostServicesQuery) {
    const conds = [];
    if (f.q) conds.push(ilike(costServices.name, `%${f.q}%`));
    if (f.valueType) conds.push(eq(costServices.valueType, f.valueType));
    if (f.enabled !== undefined) conds.push(eq(costServices.enabled, f.enabled));
    return db
      .select(columns)
      .from(costServices)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(costServices.createdAt));
  },

  /** Conteo habilitados/total. */
  async counts() {
    const [totalRow] = await db.select({ n: count() }).from(costServices);
    const [enabledRow] = await db
      .select({ n: count() })
      .from(costServices)
      .where(eq(costServices.enabled, true));
    return { total: totalRow?.n ?? 0, enabled: enabledRow?.n ?? 0 };
  },

  async findById(id: string) {
    const [row] = await db.select(columns).from(costServices).where(eq(costServices.id, id)).limit(1);
    return row ?? null;
  },

  /** True si existe otro servicio con ese nombre (case-insensitive), excluyendo `exceptId`. */
  async nameTaken(name: string, exceptId?: string) {
    const conds = [ilike(costServices.name, name)];
    if (exceptId) conds.push(ne(costServices.id, exceptId));
    const [row] = await db
      .select({ id: costServices.id })
      .from(costServices)
      .where(and(...conds))
      .limit(1);
    return Boolean(row);
  },

  async insert(values: typeof costServices.$inferInsert) {
    const [row] = await db.insert(costServices).values(values).returning(columns);
    if (!row) throw new Error('No se pudo crear el servicio.');
    return row;
  },

  async update(id: string, patch: Partial<typeof costServices.$inferInsert>) {
    const [row] = await db
      .update(costServices)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(costServices.id, id))
      .returning(columns);
    return row ?? null;
  },
};
