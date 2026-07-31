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
import {
  Permission,
  listProviderLinksSchema,
  updateClientSchema,
  updateProfileSchema,
  updateProviderLinkSchema,
} from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requireMiamiLink } from '../../core/middleware/requireMiamiLink';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { clientsService } from './clients.service';
import { providerLinkService } from './provider-link.service';

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

// --- Panel administrador: enlace con el proveedor (docs/13) ---
//
// Van ANTES de `/:id` por la misma razon que `/me/...`: "provider-links" encajaria
// en el patron del detalle y Hono lo resolveria como un casillero con ese id.
//
// Permiso `config.manage` (solo Admin), no `clients.write`: corregir el enlace a
// mano puede abrirle el portal a un cliente que el proveedor no reconoce.
//
// Ademas del permiso, las tres piden `MIAMI_LINK_ENABLED=true`: con la bandera
// apagada la pantalla no se ofrece en el portal, y estas rutas responden 403 en
// vez de quedar accesibles por URL.

/** Casilleros con problema de enlace. Sin filtro: los que no estan `synced`. */
clientsRoutes.get(
  '/provider-links',
  requireMiamiLink(),
  requirePermission(Permission.ConfigManage),
  zValidator('query', listProviderLinksSchema),
  async (c) => {
    return c.json(await providerLinkService.list(c.req.valid('query')));
  },
);

/** Enlace de un casillero con su bitacora completa (pantalla de diagnostico). */
clientsRoutes.get(
  '/:id/provider-link',
  requireMiamiLink(),
  requirePermission(Permission.ConfigManage),
  async (c) => {
    return c.json(await providerLinkService.get(c.req.param('id')));
  },
);

/** Correccion manual del enlace (estado, id de Helga, sub-casillero). */
clientsRoutes.patch(
  '/:id/provider-link',
  requireMiamiLink(),
  requirePermission(Permission.ConfigManage),
  zValidator('json', updateProviderLinkSchema),
  async (c) => {
    return c.json(
      await providerLinkService.update(c.get('session'), c.req.param('id'), c.req.valid('json')),
    );
  },
);

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
