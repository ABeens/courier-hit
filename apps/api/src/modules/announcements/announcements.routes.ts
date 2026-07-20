/**
 * Rutas de anuncios (docs/manuales/roles.md §3). Dos audiencias, dos barreras:
 *
 *   GET /active  → portal del CLIENTE. Solo exige sesion de rol `client`; no hay
 *     permiso RBAC para leer anuncios porque no es un modulo del menu, es una
 *     pieza del chrome del portal. El staff no los ve (§3.4 habla del Portal del
 *     Cliente), asi que el rol se comprueba explicitamente.
 *   resto         → panel ADMIN, permiso announcements.manage (solo admin).
 *
 * Los middleware van por ruta y no con un `use('*')` global para que la barrera
 * de cada endpoint se lea junto a el y no dependa del orden de registro.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  Permission,
  Role,
  createAnnouncementSchema,
  listAnnouncementsQuerySchema,
  updateAnnouncementSchema,
} from '@courier/shared';
import { AuthErrors } from '../../core/errors';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { announcementsService } from './announcements.service';

export const announcementsRoutes = new Hono<AppEnv>();

/** Banners vigentes del portal del cliente: ya vienen ordenados y limitados a 3. */
announcementsRoutes.get('/active', requireSession(), async (c) => {
  if (c.get('session').role !== Role.Client) throw AuthErrors.forbidden();
  return c.json(await announcementsService.listActive());
});

const adminOnly = [requireSession(), requirePermission(Permission.AnnouncementsManage)] as const;

announcementsRoutes.get('/', ...adminOnly, zValidator('query', listAnnouncementsQuerySchema), async (c) => {
  return c.json(await announcementsService.list(c.req.valid('query')));
});

announcementsRoutes.post('/', ...adminOnly, zValidator('json', createAnnouncementSchema), async (c) => {
  return c.json(await announcementsService.create(c.req.valid('json')), 201);
});

announcementsRoutes.patch('/:id', ...adminOnly, zValidator('json', updateAnnouncementSchema), async (c) => {
  return c.json(await announcementsService.update(c.req.param('id'), c.req.valid('json')));
});

announcementsRoutes.delete('/:id', ...adminOnly, async (c) => {
  await announcementsService.remove(c.req.param('id'));
  return c.body(null, 204);
});
