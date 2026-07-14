/**
 * Rutas de gestion de staff. TODO el modulo exige sesion + permiso users.manage
 * (solo admin): la barrera real esta aqui, no en el menu del cliente.
 * Contrato en docs/05-modulo-usuarios.md §3 y docs/06 §6.2.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Permission, createStaffSchema, listStaffQuerySchema, updateStaffSchema } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { usersService } from './users.service';

export const usersRoutes = new Hono<AppEnv>();

usersRoutes.use('*', requireSession(), requirePermission(Permission.UsersManage));

usersRoutes.get('/', zValidator('query', listStaffQuerySchema), async (c) => {
  return c.json(await usersService.list(c.req.valid('query')));
});

usersRoutes.post('/', zValidator('json', createStaffSchema), async (c) => {
  const created = await usersService.create(c.req.valid('json'));
  return c.json(created, 201);
});

usersRoutes.patch('/:id', zValidator('json', updateStaffSchema), async (c) => {
  const updated = await usersService.update(c.req.param('id'), c.req.valid('json'));
  return c.json(updated);
});
