/**
 * Rutas de auditoria. Solo lectura y solo admin (permiso audit.read): el
 * registro de las correcciones hechas con su comentario.
 */
import { Hono } from 'hono';
import { Permission, listCorrectionsQuerySchema } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { zValidator } from '../../core/validator';
import { auditService } from './audit.service';

export const auditRoutes = new Hono<AppEnv>();

auditRoutes.get(
  '/corrections',
  requireSession(),
  requirePermission(Permission.AuditRead),
  zValidator('query', listCorrectionsQuerySchema),
  async (c) => c.json(await auditService.listCorrections(c.req.valid('query'))),
);
