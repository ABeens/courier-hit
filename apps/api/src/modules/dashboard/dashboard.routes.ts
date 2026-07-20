/**
 * Rutas del resumen operativo. Todo el modulo exige sesion + dashboard.read.
 * Ademas expone el disparo manual del resumen diario de correo, que es una
 * automatizacion y por eso pide config.manage.
 */
import { Hono } from 'hono';
import { Permission } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { notificationsService } from '../notifications/notifications.service';
import { dashboardService } from './dashboard.service';

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.use('*', requireSession());

dashboardRoutes.get('/', requirePermission(Permission.DashboardRead), async (c) => {
  return c.json(await dashboardService.summary());
});

/**
 * Dispara el resumen diario de tramites de Transporte y Agenciamiento.
 *
 * TODO(despliegue): esto debe correr solo, una vez al dia (EventBridge -> tarea
 * programada). El endpoint queda como disparo manual para poder probar la
 * automatizacion sin esperar al planificador.
 */
dashboardRoutes.post(
  '/daily-summary',
  requirePermission(Permission.ConfigManage),
  async (c) => {
    return c.json(await notificationsService.sendDailySummary());
  },
);
