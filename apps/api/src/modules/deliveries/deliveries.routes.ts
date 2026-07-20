/**
 * Rutas del modulo de entregas. TODO el modulo exige sesion + delivery.manage:
 * es el unico recurso del sistema con una sola poblacion (Mensajeria, y el
 * administrador por herencia), asi que la barrera puede ir en el router.
 *
 * El registro del intento va como multipart porque lleva la foto; el resto del
 * modulo es JSON.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  Permission,
  listDeliveryQueueQuerySchema,
  recordDeliveryAttemptSchema,
} from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { toDto } from '../shipments/shipments.service';
import { deliveriesService } from './deliveries.service';

export const deliveriesRoutes = new Hono<AppEnv>();

deliveriesRoutes.use('*', requireSession(), requirePermission(Permission.DeliveryManage));

/** Cola del mensajero: los tramites en ruta, filtrables por nombre, tracking y ruta. */
deliveriesRoutes.get('/queue', zValidator('query', listDeliveryQueueQuerySchema), async (c) => {
  return c.json(await deliveriesService.queue(c.req.valid('query')));
});

deliveriesRoutes.get('/shipment/:shipmentId', async (c) => {
  return c.json(await deliveriesService.listByShipment(c.req.param('shipmentId')));
});

/**
 * Registro del desenlace de una visita. El cuerpo es multipart: los campos de
 * texto se validan con el esquema compartido y la foto la valida el almacen.
 */
deliveriesRoutes.post('/shipment/:shipmentId', async (c) => {
  const form = await c.req.parseBody();
  const input = recordDeliveryAttemptSchema.parse({
    outcome: form['outcome'],
    note: typeof form['note'] === 'string' && form['note'] ? form['note'] : undefined,
  });
  const photo = form['photo'] instanceof File ? form['photo'] : null;

  const row = await deliveriesService.record(
    c.get('session'),
    c.req.param('shipmentId'),
    input,
    photo,
  );
  return c.json(toDto(row), 201);
});

deliveriesRoutes.get('/attempts/:id/photo', async (c) => {
  const { body, contentType } = await deliveriesService.photoFile(c.req.param('id'));
  return c.body(body, 200, { 'content-type': contentType });
});
