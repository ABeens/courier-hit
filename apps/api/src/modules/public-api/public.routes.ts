/**
 * Rutas de la API PUBLICA, montadas en `/api/v1` (docs/16 §4).
 *
 * Tres cosas distinguen este router de todos los demas:
 *
 *   1. La barrera es la LLAVE, no la sesion (`requireApiKey`). La cookie no
 *      autentica aqui, y la llave no autentica en ningun otro sitio.
 *   2. Lleva su propio limitador, por llave. El del portal va por IP y protege
 *      otra cosa (ver `core/rate-limit.ts`).
 *   3. El contrato es ESTABLE. Cambiar la forma de una respuesta rompe
 *      integraciones que no controlamos, asi que un cambio incompatible se hace
 *      publicando `/api/v2`, no editando esto.
 *
 * El orden de los middleware importa: primero la llave, despues el limitador.
 * Al reves, el cupo lo gastaria quien mandara basura sin credencial, que es
 * justo de quien hay que defenderse; y sin llave no habria por quien limitar.
 * El aluvion anonimo lo para el WAF, antes de llegar hasta aqui.
 */
import { Hono } from 'hono';
import {
  buildPublicApiSpec,
  publicPackagesQuerySchema,
  publicPrealertSchema,
} from '@courier/shared';
import { config, publicApiRateWindowMs } from '../../core/config';
import type { AppEnv } from '../../core/http';
import { requireApiKey } from '../../core/middleware/requireApiKey';
import { RateLimiter, clientIp, rateLimit } from '../../core/rate-limit';
import { zValidator } from '../../core/validator';
import { publicApiService } from './public.service';

/** Un contador propio: agotar el cupo de la API publica no toca al del login. */
const publicApiLimiter = new RateLimiter(
  config.PUBLIC_API_RATE_LIMIT,
  publicApiRateWindowMs,
  'api-publica',
);

export const publicApiRoutes = new Hono<AppEnv>();

/**
 * El documento OpenAPI va ANTES de la barrera y sin llave, a proposito: es
 * documentacion. Pedirle credenciales a quien esta evaluando si integrarse es
 * ponerle una puerta a la puerta.
 *
 * Su limitador es el mismo pero con clave de IP: no hay llave con la que contar.
 */
publicApiRoutes.get(
  '/openapi.json',
  rateLimit(publicApiLimiter, (c) => `spec:${clientIp(c)}`),
  (c) => {
    /**
     * La URL del servidor se deriva de la peticion y no de una constante: la
     * misma imagen sirve el entorno local y produccion, y un documento que
     * apunte al sitio equivocado manda a integrar contra otro sistema.
     */
    const url = new URL(c.req.url);
    return c.json(buildPublicApiSpec(`${url.protocol}//${url.host}/api/v1`));
  },
);

publicApiRoutes.use('*', requireApiKey());
publicApiRoutes.use('*', rateLimit(publicApiLimiter, (c) => `key:${c.get('apiClient').keyId}`));

/** Consulta por usuario o cliente: la cuenta a la que pertenece la llave. */
publicApiRoutes.get('/client', async (c) => {
  return c.json(await publicApiService.client(c.get('apiClient')));
});

/** Consulta de casillero. */
publicApiRoutes.get('/locker', async (c) => {
  return c.json(await publicApiService.locker(c.get('apiClient')));
});

/**
 * Consulta de paquetes: sin filtro son todos los del cliente; con `state`, los
 * de ese estado (prealertados, por ejemplo).
 *
 * Va ANTES de `/packages/:tracking` por el orden de resolucion de Hono, igual
 * que en el resto de la API.
 */
publicApiRoutes.get('/packages', zValidator('query', publicPackagesQuerySchema), async (c) => {
  return c.json(await publicApiService.packages(c.get('apiClient'), c.req.valid('query')));
});

/** Consulta de paquete por numero de tracking. */
publicApiRoutes.get('/packages/:tracking', async (c) => {
  return c.json(await publicApiService.packageByTracking(c.get('apiClient'), c.req.param('tracking')));
});

/** Prealerta de paquete. 201 con el paquete recien creado. */
publicApiRoutes.post('/prealerts', zValidator('json', publicPrealertSchema), async (c) => {
  const created = await publicApiService.prealert(c.get('apiClient'), c.req.valid('json'));
  return c.json(created, 201);
});
