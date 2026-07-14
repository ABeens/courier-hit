/**
 * Acceso a datos de la gestion de staff. Opera sobre la tabla de identidad
 * `users` (definida en el modulo auth) filtrando SIEMPRE principal = 'staff'.
 * Nunca devuelve `password_hash` (columnas publicas explicitas).
 */
import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { Principal, Role, UserStatus } from '@courier/shared';
import type { ListStaffQuery } from '@courier/shared';
import { db } from '../../core/db';
import { users } from '../auth/auth.schema';

/** Proyeccion sin credenciales; forma equivalente a `User` del dominio. */
const publicColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  phone: users.phone,
  principal: users.principal,
  role: users.role,
  status: users.status,
  emailVerifiedAt: users.emailVerifiedAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

export const usersRepo = {
  /** Lista staff con busqueda (nombre/correo) + filtros de rol y estado. */
  async listStaff(f: ListStaffQuery) {
    const conds = [eq(users.principal, Principal.Staff)];
    if (f.role) conds.push(eq(users.role, f.role));
    if (f.status) conds.push(eq(users.status, f.status));
    if (f.q) {
      const like = `%${f.q}%`;
      conds.push(or(ilike(users.name, like), ilike(users.email, like))!);
    }
    return db.select(publicColumns).from(users).where(and(...conds)).orderBy(desc(users.createdAt));
  },

  /** Conteo activos/total del staff (docs/05 §3). */
  async staffCounts() {
    const [totalRow] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.principal, Principal.Staff));
    const [activeRow] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.principal, Principal.Staff), eq(users.status, UserStatus.Activo)));
    return { total: totalRow?.n ?? 0, active: activeRow?.n ?? 0 };
  },

  async findStaffById(id: string) {
    const [row] = await db
      .select(publicColumns)
      .from(users)
      .where(and(eq(users.id, id), eq(users.principal, Principal.Staff)))
      .limit(1);
    return row ?? null;
  },

  async insertStaff(values: typeof users.$inferInsert) {
    const [row] = await db.insert(users).values(values).returning(publicColumns);
    if (!row) throw new Error('No se pudo crear el usuario.');
    return row;
  },

  async updateStaff(id: string, patch: Partial<typeof users.$inferInsert>) {
    const [row] = await db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(users.id, id), eq(users.principal, Principal.Staff)))
      .returning(publicColumns);
    return row ?? null;
  },

  /** Cuantos administradores activos hay (salvaguarda del ultimo admin). */
  async countActiveAdmins(): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, Role.Admin), eq(users.status, UserStatus.Activo)));
    return row?.n ?? 0;
  },
};
