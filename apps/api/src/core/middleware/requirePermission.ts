/**
 * Barrera 2 (docs/04 §6): comprueba el permiso del rol de la sesion contra la
 * matriz RBAC de @courier/shared. 403 si el rol no lo tiene. Se aplica DESPUES
 * de requireSession(). Acceso directo por URL sin permiso => 403 (roles.md §4.1.5).
 */
import { createMiddleware } from 'hono/factory';
import { can } from '@courier/shared';
import type { Permission } from '@courier/shared';
import { AuthErrors } from '../errors';
import type { AppEnv } from '../http';

export function requirePermission(permission: Permission) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = c.get('session');
    if (!session || !can(session.role, permission)) throw AuthErrors.forbidden();
    await next();
  });
}
