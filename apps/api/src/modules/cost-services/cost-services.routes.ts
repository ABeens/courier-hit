/**
 * Rutas del catalogo de servicios de costo. TODO el modulo exige sesion +
 * permiso cost_services.manage (solo admin). La barrera real esta aqui.
 * Pantalla: docs/manuales/flujo.md L1-20.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  Permission,
  createCostServiceSchema,
  listCostServicesQuerySchema,
  updateCostServiceSchema,
} from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { costServicesService } from './cost-services.service';

export const costServicesRoutes = new Hono<AppEnv>();

costServicesRoutes.use('*', requireSession(), requirePermission(Permission.CostServicesManage));

costServicesRoutes.get('/', zValidator('query', listCostServicesQuerySchema), async (c) => {
  return c.json(await costServicesService.list(c.req.valid('query')));
});

costServicesRoutes.post('/', zValidator('json', createCostServiceSchema), async (c) => {
  const created = await costServicesService.create(c.req.valid('json'));
  return c.json(created, 201);
});

costServicesRoutes.patch('/:id', zValidator('json', updateCostServiceSchema), async (c) => {
  const updated = await costServicesService.update(c.req.param('id'), c.req.valid('json'));
  return c.json(updated);
});
