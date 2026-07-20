/**
 * Rutas del modulo de casilleros. El recurso lo comparten dos poblaciones, asi
 * que el permiso va por endpoint:
 *
 *   - el STAFF consulta el dashboard de clientes (clients.read) y edita lo
 *     comercial: tarifa y limite de credito (clients.write);
 *   - el CLIENTE consulta y edita SU perfil y ve su casillero de Miami. Estas dos
 *     ultimas no piden permiso de modulo: el dueño sale de la sesion, y todo
 *     titular de casillero puede ver lo suyo por definicion.
 *
 * `/me/...` va ANTES de `/:id` porque Hono resuelve por orden: "me" encajaria en
 * el patron del detalle y el cliente acabaria pidiendo un casillero ajeno.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { Permission, updateClientSchema, updateProfileSchema } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { clientsService } from './clients.service';

export const clientsRoutes = new Hono<AppEnv>();

clientsRoutes.use('*', requireSession());

// --- Portal del cliente: lo suyo ---

/** Direccion del casillero en Miami (Parte 2, "Casillero"). */
clientsRoutes.get('/me/locker', async (c) => {
  return c.json(await clientsService.locker(c.get('session')));
});

clientsRoutes.get('/me', async (c) => {
  return c.json(await clientsService.profile(c.get('session')));
});

clientsRoutes.patch('/me', zValidator('json', updateProfileSchema), async (c) => {
  return c.json(await clientsService.updateProfile(c.get('session'), c.req.valid('json')));
});

// --- Panel administrador ---

const listQuerySchema = z.object({ q: z.string().trim().optional() });

clientsRoutes.get(
  '/',
  requirePermission(Permission.ClientsRead),
  zValidator('query', listQuerySchema),
  async (c) => {
    return c.json(await clientsService.list(c.req.valid('query').q));
  },
);

clientsRoutes.get('/:id', requirePermission(Permission.ClientsRead), async (c) => {
  return c.json(await clientsService.get(c.req.param('id')));
});

/** Edicion comercial. Apaga el flag "Nuevo" como efecto del acto de editar. */
clientsRoutes.patch(
  '/:id',
  requirePermission(Permission.ClientsWrite),
  zValidator('json', updateClientSchema),
  async (c) => {
    return c.json(await clientsService.update(c.req.param('id'), c.req.valid('json')));
  },
);
