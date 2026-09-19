/**
 * Rutas del modulo de entregas. TODO el modulo exige sesion + delivery.manage:
 * es el unico recurso del sistema con una sola poblacion (Mensajeria, y el
 * administrador por herencia), asi que la barrera puede ir en el router.
 *
 * El registro del intento va como multipart porque lleva las fotos; el resto del
 * modulo es JSON.
 */
import { Hono } from 'hono';
import { zValidator } from '../../core/validator';
import {
  MAX_DELIVERY_PHOTOS,
  Permission,
  deliveryQueueFilterSchema,
  listDeliveryQueueQuerySchema,
  recordDeliveryAttemptSchema,
} from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { toDto } from '../shipments/shipments.service';
import { deliveriesService } from './deliveries.service';
import { renderDeliveryReport } from './delivery-report.render';

export const deliveriesRoutes = new Hono<AppEnv>();

deliveriesRoutes.use('*', requireSession(), requirePermission(Permission.DeliveryManage));

/** Cola del mensajero: los tramites en ruta, filtrables por nombre, tracking y ruta. */
deliveriesRoutes.get('/queue', zValidator('query', listDeliveryQueueQuerySchema), async (c) => {
  return c.json(await deliveriesService.queue(c.req.valid('query')));
});

/**
 * La cola del filtro como DOCUMENTO imprimible (la hoja de ruta que el mensajero
 * se lleva en el bolsillo). Se responde HTML y no JSON a proposito: es papel, no
 * una tabla que la pantalla vaya a pintar. Ver `delivery-report.render.ts`.
 *
 * Toma los MISMOS filtros del listado menos la paginacion: la hoja sale de una
 * ruta o de todas, pero nunca de "la primera pagina de una ruta".
 */
deliveriesRoutes.get('/queue/report', zValidator('query', deliveryQueueFilterSchema), async (c) => {
  return c.html(renderDeliveryReport(await deliveriesService.report(c.req.valid('query'))));
});

deliveriesRoutes.get('/shipment/:shipmentId', async (c) => {
  return c.json(await deliveriesService.listByShipment(c.req.param('shipmentId')));
});

/**
 * Registro del desenlace de una visita. El cuerpo es multipart: los campos de
 * texto se validan con el esquema compartido y las fotos las valida el almacen.
 *
 * `all: true` es lo que permite repetir el campo `photo` hasta
 * `MAX_DELIVERY_PHOTOS` veces: sin el, Hono se queda con la ultima y el
 * mensajero perderia en silencio las dos primeras. Con un solo archivo el valor
 * NO llega como array, asi que se normaliza antes de mirarlo.
 */
deliveriesRoutes.post('/shipment/:shipmentId', async (c) => {
  const form = await c.req.parseBody({ all: true });
  const input = recordDeliveryAttemptSchema.parse({
    outcome: form['outcome'],
    note: typeof form['note'] === 'string' && form['note'] ? form['note'] : undefined,
  });
  const raw = form['photo'];
  const photos = (Array.isArray(raw) ? raw : [raw]).filter(
    (value): value is File => value instanceof File,
  );

  const row = await deliveriesService.record(
    c.get('session'),
    c.req.param('shipmentId'),
    input,
    photos,
  );
  return c.json(toDto(row), 201);
});

/**
 * Una de las fotos del intento, por su posicion (0, 1, 2). El indice va en la
 * ruta y no como query porque forma parte de la identidad del recurso: cada foto
 * es un archivo distinto, no una vista del mismo.
 */
deliveriesRoutes.get('/attempts/:id/photos/:index', async (c) => {
  const index = Number(c.req.param('index'));
  if (!Number.isInteger(index) || index < 0 || index >= MAX_DELIVERY_PHOTOS) {
    return c.notFound();
  }
  const { body, contentType } = await deliveriesService.photoFile(c.req.param('id'), index);
  return c.body(body, 200, { 'content-type': contentType });
});
