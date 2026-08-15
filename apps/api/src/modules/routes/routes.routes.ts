/**
 * Rutas de la definicion de rutas. TODO el modulo exige sesion + permiso
 * routes.manage (solo admin). La barrera real esta aqui, no en el menu.
 *
 * Los dos niveles de asignacion cuelgan de su propio prefijo (`/districts`,
 * `/cantons`) para que el codigo de la URL no sea ambiguo: distrito y canton son
 * codigos numericos de distinta longitud y comparten el mismo cuerpo.
 */
import { Hono } from 'hono';
import { zValidator } from '../../core/validator';
import { Permission, upsertCantonRouteSchema, upsertDistrictRouteSchema } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { routesService } from './routes.service';

export const routesRoutes = new Hono<AppEnv>();

routesRoutes.use('*', requireSession(), requirePermission(Permission.RoutesManage));

routesRoutes.get('/', async (c) => {
  return c.json(await routesService.list());
});

routesRoutes.put(
  '/districts/:districtCode',
  zValidator('json', upsertDistrictRouteSchema),
  async (c) => {
    const saved = await routesService.assign(c.req.param('districtCode'), c.req.valid('json'));
    return c.json(saved);
  },
);

routesRoutes.delete('/districts/:districtCode', async (c) => {
  const result = await routesService.remove(c.req.param('districtCode'));
  return c.json(result);
});

routesRoutes.put('/cantons/:cantonCode', zValidator('json', upsertCantonRouteSchema), async (c) => {
  const saved = await routesService.assignCanton(c.req.param('cantonCode'), c.req.valid('json'));
  return c.json(saved);
});

routesRoutes.delete('/cantons/:cantonCode', async (c) => {
  const result = await routesService.removeCanton(c.req.param('cantonCode'));
  return c.json(result);
});
