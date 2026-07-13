/**
 * Barrera 1 (docs/04 §6): lee la cookie httpOnly, resuelve la sesion en
 * servidor y la pone en el contexto. 401 si no hay sesion valida.
 */
import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { config } from '../config';
import { AuthErrors } from '../errors';
import type { AppEnv } from '../http';
import { authService } from '../../modules/auth/auth.service';

export function requireSession() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const sid = getCookie(c, config.SESSION_COOKIE_NAME);
    if (!sid) throw AuthErrors.unauthorized();

    const session = await authService.resolveSession(sid);
    if (!session) throw AuthErrors.unauthorized('Sesión inválida o expirada.');

    c.set('session', session);
    await next();
  });
}
