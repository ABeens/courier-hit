/**
 * Variante de `requirePermission` para endpoints que sirven a dos poblaciones con
 * permisos distintos sobre el mismo recurso. Caso real: el listado de tramites lo
 * consumen el staff (package.read, ve todo) y el cliente (package.read.own, ve lo
 * suyo). Basta con tener UNO de los permisos para pasar la barrera.
 *
 * OJO: esto solo abre la puerta. El ALCANCE (que filas ve cada quien) NO se
 * decide aqui sino en el servicio, que acota por el casillero de la sesion
 * cuando el permiso es de scope Own.
 */
import { createMiddleware } from 'hono/factory';
import { can } from '@courier/shared';
import type { Permission } from '@courier/shared';
import { AuthErrors } from '../errors';
import type { AppEnv } from '../http';

export function requireAnyPermission(...permissions: Permission[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = c.get('session');
    if (!session || !permissions.some((p) => can(session.role, p))) throw AuthErrors.forbidden();
    await next();
  });
}
