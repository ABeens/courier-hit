/**
 * Rutas de los tramites. Todo el modulo exige sesion; el permiso concreto va por
 * endpoint porque el recurso lo comparten dos poblaciones:
 *
 *   - el CLIENTE prealerta (prealert.create) y consulta lo suyo (package.read.own);
 *   - el STAFF da de alta, edita y consulta todo (package.write / tramite.manage
 *     segun el tipo, package.read).
 *
 * En el alta y la edicion la barrera de permiso NO puede ser un middleware fijo:
 * depende del tipo de tramite, que viaja en el cuerpo o esta en la fila. Esa
 * comprobacion vive en el servicio (`assertCanWrite`), que es quien conoce el tipo.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  Permission,
  createShipmentSchema,
  listShipmentsQuerySchema,
  prealertShipmentSchema,
  receiveShipmentSchema,
  transitionShipmentSchema,
  updateShipmentSchema,
} from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requireAnyPermission } from '../../core/middleware/requireAnyPermission';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { providerSyncService } from './provider-sync.service';
import { receptionService } from './reception.service';
import { shipmentsService, toDto } from './shipments.service';
import { transitionsService } from './transitions.service';

export const shipmentsRoutes = new Hono<AppEnv>();

shipmentsRoutes.use('*', requireSession());

/** Puede leer tramites: el staff (todos) o el cliente (los suyos). */
const canRead = requireAnyPermission(Permission.PackageRead, Permission.PackageReadOwn);

/** Puede escribir tramites: bodega (Paqueteria) o gestion de tramites (el resto). */
const canWrite = requireAnyPermission(Permission.PackageWrite, Permission.TramiteManage);

shipmentsRoutes.get('/', canRead, zValidator('query', listShipmentsQuerySchema), async (c) => {
  return c.json(await shipmentsService.list(c.get('session'), c.req.valid('query')));
});

/** Prealerta del titular del casillero. El dueño sale de la sesion, no del cuerpo. */
shipmentsRoutes.post(
  '/prealert',
  requirePermission(Permission.PrealertCreate),
  zValidator('json', prealertShipmentSchema),
  async (c) => {
    const created = await shipmentsService.prealert(c.get('session'), c.req.valid('json'));
    return c.json(created, 201);
  },
);

/** Alta por staff. El permiso definitivo lo valida el servicio segun el tipo. */
shipmentsRoutes.post('/', canWrite, zValidator('json', createShipmentSchema), async (c) => {
  const created = await shipmentsService.create(c.get('session'), c.req.valid('json'));
  return c.json(created, 201);
});

/**
 * Sincronizacion manual con el proveedor.
 *
 * TODO(13): debe correr sola cada N minutos. El endpoint queda como disparo
 * manual para poder probarla sin esperar al planificador.
 */
shipmentsRoutes.post('/sync-provider', requirePermission(Permission.ConfigManage), async (c) => {
  return c.json(await providerSyncService.run(c.get('session')));
});

/**
 * Recepcion en bodega por tracking (Parte 4). Va ANTES de `/:id` porque Hono
 * resuelve por orden: `/receive` encajaria en el patron del detalle.
 */
shipmentsRoutes.post(
  '/receive',
  requirePermission(Permission.PackageReceive),
  zValidator('json', receiveShipmentSchema),
  async (c) => {
    const row = await receptionService.receive(c.get('session'), c.req.valid('json'));
    return c.json(toDto(row));
  },
);

shipmentsRoutes.get('/:id', canRead, async (c) => {
  return c.json(await shipmentsService.get(c.get('session'), c.req.param('id')));
});

shipmentsRoutes.get('/:id/events', canRead, async (c) => {
  return c.json(await shipmentsService.events(c.get('session'), c.req.param('id')));
});

shipmentsRoutes.patch('/:id', canWrite, zValidator('json', updateShipmentSchema), async (c) => {
  const updated = await shipmentsService.update(c.get('session'), c.req.param('id'), c.req.valid('json'));
  return c.json(updated);
});

/**
 * Avance manual de estado. NO lleva middleware de permiso: el que hace falta
 * depende del estado DESTINO (la maquina lo declara por step), asi que solo el
 * servicio puede resolverlo. Una barrera fija aqui seria o demasiado laxa o
 * demasiado estricta segun a donde se mueva el tramite.
 */
shipmentsRoutes.post('/:id/transition', zValidator('json', transitionShipmentSchema), async (c) => {
  const row = await transitionsService.transition(
    c.get('session'),
    c.req.param('id'),
    c.req.valid('json'),
  );
  return c.json(toDto(row));
});
