/**
 * Rutas de los ajustes generales, bajo `/api/settings`.
 *
 * La barrera es distinta por verbo y es deliberado: LEER la tasa vigente lo
 * necesita todo el que carga montos (costos, pagos), FIJARLA solo quien tiene
 * `exchange_rate.write`. Poner la barrera de escritura sobre todo el modulo
 * dejaria al operador sin poder ver con que tasa esta facturando.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Permission, setExchangeRateSchema } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requireAnyPermission } from '../../core/middleware/requireAnyPermission';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { settingsService } from './settings.service';

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.use('*', requireSession());

/** Tasa vigente + referencia del BCCR. La lee quien opera con montos. */
settingsRoutes.get(
  '/exchange-rate',
  requireAnyPermission(
    Permission.ExchangeRateWrite,
    Permission.CostsManage,
    Permission.CostsTramiteManage,
    Permission.PaymentsValidate,
  ),
  async (c) => {
    return c.json(await settingsService.exchangeRate());
  },
);

/** Historial de cambios: es auditoria, la ve quien puede fijar la tasa. */
settingsRoutes.get(
  '/exchange-rate/history',
  requirePermission(Permission.ExchangeRateWrite),
  async (c) => {
    return c.json({ items: await settingsService.exchangeRateHistory() });
  },
);

settingsRoutes.put(
  '/exchange-rate',
  requirePermission(Permission.ExchangeRateWrite),
  zValidator('json', setExchangeRateSchema),
  async (c) => {
    return c.json(await settingsService.setExchangeRate(c.get('session'), c.req.valid('json')));
  },
);
