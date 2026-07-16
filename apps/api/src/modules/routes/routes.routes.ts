/**
 * Rutas de la definicion de rutas. TODO el modulo exige sesion + permiso
 * routes.manage (solo admin). La barrera real esta aqui, no en el menu.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Permission, upsertDistrictRouteSchema } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { routesService } from './routes.service';

export const routesRoutes = new Hono<AppEnv>();

routesRoutes.use('*', requireSession(), requirePermission(Permission.RoutesManage));

routesRoutes.get('/', async (c) => {
  return c.json(await routesService.list());
});

routesRoutes.put('/:districtCode', zValidator('json', upsertDistrictRouteSchema), async (c) => {
  const saved = await routesService.assign(c.req.param('districtCode'), c.req.valid('json'));
  return c.json(saved);
});

routesRoutes.delete('/:districtCode', async (c) => {
  const result = await routesService.remove(c.req.param('districtCode'));
  return c.json(result);
});
