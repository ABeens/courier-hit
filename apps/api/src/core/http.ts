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
  app.get('/health', (c) => c.json({ ok: true }));

  return app;
}

export type App = ReturnType<typeof createApp>;
