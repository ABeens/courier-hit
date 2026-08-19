/**
 * App Hono base: CORS restringido al origen de la web, logger y handler de
 * errores unico. Cada modulo aporta su router y se monta en main.ts.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Session } from '@courier/shared';
import { config } from './config';
import { onError } from './errors';

/** Variables que los middleware ponen en el contexto de la request. */
export type AppEnv = {
  Variables: {
    session: Session;
  };
};

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', logger());
  app.use(
    '*',
    cors({
      origin: config.WEB_ORIGIN,
      credentials: true, // necesario para la cookie de sesion
    }),
  );

  app.onError(onError);

  /**
   * Sonda de salud, en las DOS rutas a proposito.
   *
   *   - `/health`     — desde dentro del contenedor. Es la que usa el
   *                     HEALTHCHECK de la imagen, que habla con 127.0.0.1 y no
   *                     pasa por ningun proxy.
   *   - `/api/health` — desde fuera. CloudFront solo enruta hacia la API lo que
   *                     empieza por `/api/`, asi que sin esta la sonda es
   *                     inalcanzable desde internet y no sirve para comprobar un
   *                     despliegue (docs/12).
   */
  const health = (c: { json: (body: unknown) => Response }) => c.json({ ok: true });
  app.get('/health', health);
  app.get('/api/health', health);

  return app;
}

export type App = ReturnType<typeof createApp>;
