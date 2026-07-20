/**
 * Rutas de los costos de un tramite, bajo `/api/costs/:shipmentId`.
 *
 * Por que un prefijo propio y no `/api/shipments/:id/costs`: el middleware de
 * este modulo exige permiso de costos, y montarlo bajo `/api/shipments` se lo
 * aplicaria tambien a los endpoints de tramites, que un CLIENTE si puede usar.
 * El prefijo separado mantiene la barrera acotada a lo que cubre.
 *
 * La barrera de aqui es GRUESA (tener alguno de los dos permisos de costos); la
 * fina —cual de los dos segun el tipo de tramite— la aplica el servicio, que es
 * quien conoce el flow de la fila.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Permission, saveShipmentCostsSchema } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requireAnyPermission } from '../../core/middleware/requireAnyPermission';
import { requireSession } from '../../core/middleware/requireSession';
import { costsService } from './costs.service';

export const costsRoutes = new Hono<AppEnv>();

costsRoutes.use(
  '*',
  requireSession(),
  requireAnyPermission(Permission.CostsManage, Permission.CostsTramiteManage),
);

/**
 * Tasa de cambio sugerida del dia (BCCR). El operador la confirma o la cambia.
 * Va ANTES de `/:shipmentId` para que la ruta estatica gane al parametro.
 */
costsRoutes.get('/exchange-rate', async (c) => {
  return c.json(await costsService.suggestedRate());
});

costsRoutes.get('/:shipmentId', async (c) => {
  return c.json(await costsService.get(c.get('session'), c.req.param('shipmentId')));
});

/** Reemplaza el juego completo de lineas (ver saveShipmentCostsSchema). */
costsRoutes.put('/:shipmentId', zValidator('json', saveShipmentCostsSchema), async (c) => {
  return c.json(
    await costsService.save(c.get('session'), c.req.param('shipmentId'), c.req.valid('json')),
  );
});

/** Aprobar: congela el total y avanza a "En bodega - Pendiente pago". */
costsRoutes.post('/:shipmentId/approve', async (c) => {
  return c.json(await costsService.approve(c.get('session'), c.req.param('shipmentId')));
});
