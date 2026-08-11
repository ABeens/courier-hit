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
import { zValidator } from '../../core/validator';
import {
  Permission,
  correctStateSchema,
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
import { StorageErrors } from '../../core/storage';
import { providerSyncService } from './provider-sync.service';
import { receptionService } from './reception.service';
import { shipmentsService, toDto } from './shipments.service';
import { transitionsService } from './transitions.service';

export const shipmentsRoutes = new Hono<AppEnv>();

shipmentsRoutes.use('*', requireSession());

/**
 * Puede leer tramites: el staff (todos) o el cliente (los suyos). El cliente
 * entra por dos puertas segun el modulo del que venga —"Mis paquetes"
 * (package.read.own) y "Otros tramites" (tramite.read.own)—, pero el recorte a
 * lo suyo no depende del permiso con el que pase: lo pone `ownerScopeFor` a
 * partir del rol de la sesion.
 */
const canRead = requireAnyPermission(
  Permission.PackageRead,
  Permission.PackageReadOwn,
  Permission.TramiteReadOwn,
);

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
 * Recepcion en bodega por HAWB (LES) (Parte 4). Va ANTES de `/:id` porque Hono
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

/**
 * Documento adjunto del tramite (la factura de la compra, tipicamente). Va como
 * multipart porque lleva un archivo; el resto del modulo es JSON.
 *
 * La barrera es `canRead` y no `canWrite` a proposito: adjuntar el documento es
 * parte de prealertar, y el cliente solo tiene permisos de LECTURA sobre sus
 * tramites (`package.read.own`). Con `canWrite` ningun cliente podria adjuntar
 * nada. Quien puede escribir es siempre el dueño del tramite o el staff, y de eso
 * se encarga el servicio, que resuelve el acceso con las mismas reglas del
 * detalle (404 si el tramite no es suyo). Mismo criterio que el comprobante de
 * deposito en el modulo de pagos.
 */
shipmentsRoutes.post('/:id/document', canRead, async (c) => {
  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File)) throw StorageErrors.fileRequired('el documento del trámite');

  return c.json(await shipmentsService.attachDocument(c.get('session'), c.req.param('id'), file));
});

/**
 * Descarga del documento. `attachment` y no `inline`: un .docx o un .xlsx no los
 * pinta el navegador, y forzar la descarga evita la pantalla en blanco. El nombre
 * lo arma el servicio a partir del consecutivo, nunca del archivo original.
 */
shipmentsRoutes.get('/:id/document', canRead, async (c) => {
  const { body, contentType, filename } = await shipmentsService.documentFile(
    c.get('session'),
    c.req.param('id'),
  );
  return c.body(body, 200, {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${filename}"`,
  });
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

/**
 * Correccion administrativa del estado (retroceder o saltar). Al reves que
 * `/transition`, aqui SI hay un permiso fijo: no depende del destino porque no se
 * esta operando el proceso sino enmendandolo, y eso solo lo hace `admin`.
 */
shipmentsRoutes.post(
  '/:id/correct-state',
  requirePermission(Permission.ShipmentCorrect),
  zValidator('json', correctStateSchema),
  async (c) => {
    const row = await transitionsService.correct(
      c.get('session'),
      c.req.param('id'),
      c.req.valid('json'),
    );
    return c.json(toDto(row));
  },
);
