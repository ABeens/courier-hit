/**
 * Rutas del modulo auth. Nucleo (customer): register, verify, login, logout, me.
 * Mas los dos caminos que fijan contrasena desde un enlace del correo:
 * accept-invite (alta de staff) y forgot-password + reset-password (olvido).
 * Contrato en docs/04 §5. Toda entrada se valida con Zod (@courier/shared).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '../../core/validator';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  acceptInviteSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifySchema,
} from '@courier/shared';
import { authRateWindowMs, config, isProd, miamiLinkEnabled } from '../../core/config';
import type { AppEnv } from '../../core/http';
import { requireSession } from '../../core/middleware/requireSession';
import { RateLimiter, clientIp, rateLimit } from '../../core/rate-limit';
import { authService } from './auth.service';

export const authRoutes = new Hono<AppEnv>();

/**
 * Freno de fuerza bruta sobre los endpoints de CREDENCIALES (docs/04 §7, que lo
 * tenia pendiente). Va por IP porque en el momento de la peticion todavia no hay
 * nadie autenticado; el razonamiento de por que no por correo esta en
 * `AUTH_RATE_LIMIT`.
 *
 * Cubre `/login`, `/register`, `/verify`, `/accept-invite`, `/forgot-password` y
 * `/reset-password`. Los cuatro ultimos no son un descuido: verificar es
 * adivinar un codigo de seis digitos, y aceptar una invitacion o restablecer es
 * adivinar un token; los tres se rompen probando. `/forgot-password` entra
 * ademas por otro motivo: sin freno es una maquina de mandar correos a cuenta
 * ajena, y quemar la reputacion del remitente.
 *
 * NO cubre `/logout` ni `/me`: no hay nada que adivinar ahi, y limitarlos
 * significaria echar de su sesion a un cliente que solo estaba navegando.
 */
const credentialsLimiter = new RateLimiter(
  config.AUTH_RATE_LIMIT,
  authRateWindowMs,
  'credenciales',
);
const limitCredentials = rateLimit(credentialsLimiter, clientIp);

function setSessionCookie(c: Context<AppEnv>, value: string, expiresAt: Date): void {
  setCookie(c, config.SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax',
    path: '/',
    expires: expiresAt,
  });
}

authRoutes.post('/register', limitCredentials, zValidator('json', registerSchema), async (c) => {
  const result = await authService.register(c.req.valid('json'));
  return c.json(result, 201);
});

authRoutes.post('/verify', limitCredentials, zValidator('json', verifySchema), async (c) => {
  const result = await authService.verify(c.req.valid('json'));
  return c.json(result);
});

// Aceptar invitacion de staff: fija la contrasena desde el token del correo (publico).
authRoutes.post('/accept-invite', limitCredentials, zValidator('json', acceptInviteSchema), async (c) => {
  const result = await authService.setPasswordFromToken(c.req.valid('json'));
  return c.json(result);
});

/**
 * "Olvide mi contrasena": manda el enlace de restablecimiento al correo.
 *
 * Responde SIEMPRE `{ ok: true }`, exista o no la cuenta. Es deliberado y es la
 * regla de este endpoint: cualquier otra respuesta (un 404, un mensaje distinto,
 * incluso tardar mas) lo convierte en un oraculo para averiguar que correos
 * tienen casillero en HS Global. El usuario legitimo no pierde nada: si el
 * correo era el suyo, le llega.
 */
authRoutes.post('/forgot-password', limitCredentials, zValidator('json', forgotPasswordSchema), async (c) => {
  const result = await authService.requestPasswordReset(c.req.valid('json'));
  return c.json(result);
});

// Fija la contrasena nueva desde el token del correo (publico). Al hacerlo se
// revocan todas las sesiones abiertas de esa cuenta (ver `setPasswordFromToken`).
authRoutes.post('/reset-password', limitCredentials, zValidator('json', resetPasswordSchema), async (c) => {
  const result = await authService.setPasswordFromToken(c.req.valid('json'));
  return c.json(result);
});

authRoutes.post('/login', limitCredentials, zValidator('json', loginSchema), async (c) => {
  const { session, expiresAt } = await authService.login(c.req.valid('json'), {
    userAgent: c.req.header('user-agent'),
  });
  setSessionCookie(c, session.sessionId, expiresAt);
  // Un login CORRECTO devuelve el cupo consumido: el contador esta para frenar a
  // quien prueba contrasenas, no para castigar una oficina entera que comparte
  // salida a internet y entra a trabajar a la misma hora.
  credentialsLimiter.reset(clientIp(c));
  return c.json({ principal: session.principal, role: session.role, clientCode: session.clientCode });
});

authRoutes.post('/logout', requireSession(), async (c) => {
  await authService.logout(c.get('session').sessionId);
  deleteCookie(c, config.SESSION_COOKIE_NAME, { path: '/' });
  return c.json({ ok: true });
});

/**
 * Sesion hidratada del portal. Ademas del rol viajan las banderas que cambian lo
 * que el portal OFRECE (`features`), no lo que permite: el permiso sigue
 * saliendo del rol y lo revalida cada endpoint.
 *
 * Son de dos clases y conviven a proposito, porque el portal hace lo mismo con
 * las dos (quitar un modulo del menu): unas son del DESPLIEGUE (`miamiLink`, del
 * .env) y otras de la CUENTA que pregunta (`apiAccess`, encendida casillero por
 * casillero). Un cliente sin API habilitada no ve la pantalla "API"; un staff
 * nunca la tiene, y por eso llega en `false`.
 */
authRoutes.get('/me', requireSession(), (c) => {
  const s = c.get('session');
  return c.json({
    userId: s.userId,
    principal: s.principal,
    role: s.role,
    clientCode: s.clientCode,
    features: { miamiLink: miamiLinkEnabled, apiAccess: s.apiAccess === true },
  });
});
