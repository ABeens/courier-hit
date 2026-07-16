/**
 * Rutas de las tarifas preferenciales de cliente. TODO el modulo exige sesion +
 * permiso tariffs.manage (solo admin). La barrera real esta aqui, no en el menu.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Permission, createClientRateSchema, updateClientRateSchema } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { tariffsService } from './tariffs.service';

export const tariffsRoutes = new Hono<AppEnv>();

tariffsRoutes.use('*', requireSession(), requirePermission(Permission.TariffsManage));

tariffsRoutes.get('/client-rates', async (c) => {
  return c.json(await tariffsService.list());
});

tariffsRoutes.post('/client-rates', zValidator('json', createClientRateSchema), async (c) => {
  const created = await tariffsService.create(c.req.valid('json'));
  return c.json(created, 201);
});

tariffsRoutes.patch('/client-rates/:id', zValidator('json', updateClientRateSchema), async (c) => {
  const updated = await tariffsService.update(c.req.param('id'), c.req.valid('json'));
  return c.json(updated);
});

tariffsRoutes.delete('/client-rates/:id', async (c) => {
  const result = await tariffsService.remove(c.req.param('id'));
  return c.json(result);
});
