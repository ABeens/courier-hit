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
 * Envia el CORREO DIARIO a los clientes ya, sin esperar a la hora configurada.
 * Lo programa el robot (tarea `daily-digest`); este disparo manual queda para
 * probarlo y para reenviar si hizo falta. Cuenta la misma ventana que contaria el
 * robot (desde el envio anterior) y deja constancia del envio.
 */
dashboardRoutes.post(
  '/daily-summary',
  requirePermission(Permission.ConfigManage),
  async (c) => {
    return c.json(await notificationsService.runNow());
  },
);
