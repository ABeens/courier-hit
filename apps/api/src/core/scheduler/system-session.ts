import { and, asc, eq } from 'drizzle-orm';
import { Principal, Role, UserStatus } from '@courier/shared';
import type { Session } from '@courier/shared';
import { db } from '../db';
import { users } from '../../modules/auth/auth.schema';

/**
 * Sesion sintetica para las tareas de fondo. La sincronizacion del proveedor
 * escribe eventos de historial con `createdBy`, que es una FK a un usuario real;
 * por eso el robot actua "como" el staff mas antiguo activo en vez de con un id
 * inventado (que romperia la FK). `sessionId: 'system'` deja claro en cualquier
 * traza que el movimiento no lo hizo una persona sino el robot.
 *
 * Devuelve null si todavia no hay ningun staff activo (base recien sembrada sin
 * admin): la tarea que la use debe omitirse, no fallar.
 */
export async function resolveSystemSession(): Promise<Session | null> {
  const [staff] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.principal, Principal.Staff), eq(users.status, UserStatus.Activo)))
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (!staff) return null;

  return {
    sessionId: 'system',
    userId: staff.id,
    principal: Principal.Staff,
    role: staff.role as Role,
  };
}
