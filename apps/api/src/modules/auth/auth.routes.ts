/**
 * Rutas del modulo auth. Nucleo (customer): register, verify, login, logout, me.
 * Contrato en docs/04 §5. Toda entrada se valida con Zod (@courier/shared).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { deleteCookie, setCookie } from 'hono/cookie';
import { acceptInviteSchema, loginSchema, registerSchema, verifySchema } from '@courier/shared';
import { config, isProd } from '../../core/config';
import type { AppEnv } from '../../core/http';
import { requireSession } from '../../core/middleware/requireSession';
import { authService } from './auth.service';

export const authRoutes = new Hono<AppEnv>();

function setSessionCookie(c: Context<AppEnv>, value: string, expiresAt: Date): void {
  setCookie(c, config.SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax',
    path: '/',
    expires: expiresAt,
  });
}

authRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
  const result = await authService.register(c.req.valid('json'));
  return c.json(result, 201);
});

authRoutes.post('/verify', zValidator('json', verifySchema), async (c) => {
  const result = await authService.verify(c.req.valid('json'));
  return c.json(result);
});

// Aceptar invitacion de staff: fija la contrasena desde el token del correo (publico).
authRoutes.post('/accept-invite', zValidator('json', acceptInviteSchema), async (c) => {
  const result = await authService.acceptInvite(c.req.valid('json'));
  return c.json(result);
});

authRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
  const { session, expiresAt } = await authService.login(c.req.valid('json'), {
    userAgent: c.req.header('user-agent'),
  });
  setSessionCookie(c, session.sessionId, expiresAt);
  return c.json({ principal: session.principal, role: session.role, clientCode: session.clientCode });
});

authRoutes.post('/logout', requireSession(), async (c) => {
  await authService.logout(c.get('session').sessionId);
  deleteCookie(c, config.SESSION_COOKIE_NAME, { path: '/' });
  return c.json({ ok: true });
});

authRoutes.get('/me', requireSession(), (c) => {
  const s = c.get('session');
  return c.json({ userId: s.userId, principal: s.principal, role: s.role, clientCode: s.clientCode });
});
