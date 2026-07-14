/**
 * Arranque: monta los modulos bajo /api y levanta el servidor (docs/02-api.md §4).
 */
import { serve } from '@hono/node-server';
import { config } from './core/config';
import { createApp } from './core/http';
import { authRoutes } from './modules/auth/auth.routes';
import { usersRoutes } from './modules/users/users.routes';

const app = createApp();
app.route('/api/auth', authRoutes);
app.route('/api/users', usersRoutes);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[api] escuchando en http://localhost:${info.port}`);
});

export { app };
