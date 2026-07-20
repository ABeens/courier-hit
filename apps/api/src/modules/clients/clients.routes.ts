/**
 * Rutas del dashboard de casilleros (docs/manuales/flujo.md L148-155). Todo el
 * modulo exige sesion + clients.read: lo consumen el listado de clientes y el
 * selector de cliente del alta de tramites.
 *
 * La edicion del casillero (que ademas apaga el flag "nuevo") llega con el
 * modulo de clientes completo; aqui solo va la lectura que el alta necesita.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { Permission } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { clientsService } from './clients.service';

export const clientsRoutes = new Hono<AppEnv>();

clientsRoutes.use('*', requireSession(), requirePermission(Permission.ClientsRead));

const listQuerySchema = z.object({ q: z.string().trim().optional() });

clientsRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  return c.json(await clientsService.list(c.req.valid('query').q));
});
