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
import { zValidator } from '../../core/validator';
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

// La tasa de cambio ya no se consulta aqui: es un ajuste general del sistema y
// vive en `GET /api/settings/exchange-rate`. Este modulo solo la USA.
costsRoutes.get('/:shipmentId', async (c) => {
  return c.json(await costsService.get(c.get('session'), c.req.param('shipmentId')));
});

/** Reemplaza el juego completo de lineas (ver saveShipmentCostsSchema). */
costsRoutes.put('/:shipmentId', zValidator('json', saveShipmentCostsSchema), async (c) => {
  return c.json(
    await costsService.save(c.get('session'), c.req.param('shipmentId'), c.req.valid('json')),
  );
});

/*
 * Aprobar y reversar ya no viven aqui: con el modulo de proformas se aprueba la
 * PROFORMA (que congela todos sus tramites juntos y les asigna el numero) y se
 * corrige la proforma, no el tramite suelto. Ver `modules/proformas`.
 */
