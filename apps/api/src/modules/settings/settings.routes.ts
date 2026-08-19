/**
 * Rutas de los ajustes generales, bajo `/api/settings`.
 *
 * La barrera es distinta por verbo y es deliberado: LEER la tasa vigente lo
 * necesita todo el que carga montos (costos, pagos), FIJARLA solo quien tiene
 * `exchange_rate.write`. Poner la barrera de escritura sobre todo el modulo
 * dejaria al operador sin poder ver con que tasa esta facturando.
 */
import { Hono } from 'hono';
import { zValidator } from '../../core/validator';
import { Permission, setExchangeRateSchema, setFreightRateSchema } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requireAnyPermission } from '../../core/middleware/requireAnyPermission';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { settingsService } from './settings.service';

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.use('*', requireSession());

/** Tasa vigente + referencia del dia. La lee quien opera con montos. */
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

/**
 * Tarifa de transporte internacional (USD por libra).
 *
 * La LEE, ademas de quien la fija, quien aprueba costos: al aprobar se congela en
 * el tramite, asi que el operador tiene que poder ver con que numero va a quedar
 * marcado el paquete que esta facturando.
 */
settingsRoutes.get(
  '/freight-rate',
  requireAnyPermission(
    Permission.FreightRateWrite,
    Permission.CostsManage,
    Permission.CostsTramiteManage,
  ),
  async (c) => {
    return c.json(await settingsService.freightRate());
  },
);

settingsRoutes.put(
  '/freight-rate',
  requirePermission(Permission.FreightRateWrite),
  zValidator('json', setFreightRateSchema),
  async (c) => {
    return c.json(await settingsService.setFreightRate(c.get('session'), c.req.valid('json')));
  },
);
