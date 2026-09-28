/**
 * Rutas del modulo de proformas, bajo `/api/proformas`.
 *
 * Dos barreras: leer (`proformas.read`: consultar y descargar el documento) y
 * operar (`proformas.manage`: ajustar borradores, aprobar y corregir). El
 * contador de la serie es configuracion del sistema y pide `config.manage`.
 *
 * Las rutas fijas (`/counter`, `/approve`) van ANTES que las de `/:id`: Hono
 * resuelve en orden de registro y `/:id` se tragaria "counter" como un id.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  Permission,
  ProformaStatus,
  Role,
  approveProformasSchema,
  proformaFilterSchema,
  dispatchProformasSchema,
  assignShipmentOwnerSchema,
  correctProformaSchema,
  listProformasQuerySchema,
  moveProformaShipmentSchema,
  saveProformaCostsSchema,
  setProformaCounterSchema,
  updateProformaSchema,
} from '@courier/shared';
import { ProformaErrors } from '../../core/errors';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { zValidator } from '../../core/validator';
import { renderProforma, renderProformaCsv, renderProformaListCsv, renderProformas } from './proforma.render';
import { proformasRepo } from './proformas.repo';
import { proformasService } from './proformas.service';

export const proformasRoutes = new Hono<AppEnv>();

proformasRoutes.use('*', requireSession());

const read = requirePermission(Permission.ProformasRead);
const manage = requirePermission(Permission.ProformasManage);

/**
 * El documento lo abre el staff con permiso de lectura y TAMBIEN el cliente dueño
 * de la proforma, para ver lo que va a pagar. Al cliente solo se le muestran las
 * aprobadas y pagadas: un borrador es trabajo interno, todavia no es un documento.
 * A lo ajeno se responde 404, igual que en el resto del portal.
 */
const readOwnOrStaff: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get('session');
  if (session.role !== Role.Client) return read(c, next);
  const proforma = await proformasRepo.findById(c.req.param('id') ?? '');
  if (!proforma || proforma.clientId !== session.clientId || proforma.status === ProformaStatus.Borrador) {
    throw ProformaErrors.notFound();
  }
  await next();
};

// --- Configuracion de la serie ---------------------------------------------

proformasRoutes.get('/counter', requirePermission(Permission.ConfigManage), async (c) => {
  return c.json(await proformasService.counter());
});

proformasRoutes.put(
  '/counter',
  requirePermission(Permission.ConfigManage),
  zValidator('json', setProformaCounterSchema),
  async (c) => c.json(await proformasService.setCounter(c.req.valid('json'))),
);

// --- Bandeja ----------------------------------------------------------------

proformasRoutes.get('/', read, zValidator('query', listProformasQuerySchema), async (c) => {
  return c.json(await proformasService.list(c.req.valid('query')));
});

/** Aprobacion en bloque: cada una en su transaccion, con el resultado de cada una. */
proformasRoutes.post('/approve', manage, zValidator('json', approveProformasSchema), async (c) => {
  return c.json(await proformasService.approveMany(c.get('session'), c.req.valid('json').ids));
});

/**
 * Enviar a ruta: pasa a "En ruta de entrega" los paquetes de proformas pagadas.
 * Es el permiso de entregas (Administrador y Mensajeria), el mismo que exige la
 * maquina de estados para ese paso; sirve para una proforma o para varias.
 */
proformasRoutes.post(
  '/dispatch',
  requirePermission(Permission.DeliveryManage),
  zValidator('json', dispatchProformasSchema),
  async (c) => {
    return c.json(await proformasService.dispatchMany(c.get('session'), c.req.valid('json').ids));
  },
);

/**
 * REPORTE de proformas: el filtro de la bandeja en CSV, una fila por proforma
 * (numero, cliente, estado, entrega, totales, FE y fechas).
 */
proformasRoutes.get('/export.csv', read, zValidator('query', proformaFilterSchema), async (c) => {
  const { items, total, electronicInvoice } = await proformasService.exportList(c.req.valid('query'));
  return c.body(renderProformaListCsv(items, total, electronicInvoice), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="proformas.csv"',
  });
});

/** Todas las proformas del filtro en un documento, una por pagina, para imprimir o guardar como PDF. */
proformasRoutes.get('/documents', read, zValidator('query', proformaFilterSchema), async (c) => {
  const { docs, total } = await proformasService.documents(c.req.valid('query'));
  return c.html(renderProformas(docs, total));
});

// --- Una proforma -----------------------------------------------------------

proformasRoutes.get('/:id', read, async (c) => {
  return c.json(await proformasService.get(c.req.param('id')));
});

/**
 * El documento para imprimir o guardar como PDF. Un borrador sale como vista
 * previa, con la marca BORRADOR y sin numero (objetivo 9).
 */
proformasRoutes.get('/:id/document', readOwnOrStaff, async (c) => {
  return c.html(renderProforma(await proformasService.document(c.req.param('id'))));
});

/** Detalle por paquete en CSV (objetivo 12). */
proformasRoutes.get('/:id/export.csv', read, async (c) => {
  const doc = await proformasService.document(c.req.param('id'));
  const name = doc.number ? `proforma-${doc.number}` : 'proforma-borrador';
  return c.body(renderProformaCsv(doc), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${name}.csv"`,
  });
});

proformasRoutes.patch('/:id', manage, zValidator('json', updateProformaSchema), async (c) => {
  return c.json(await proformasService.update(c.req.param('id'), c.req.valid('json')));
});

/** Datos del editor de servicios adicionales de la proforma. */
proformasRoutes.get('/:id/costs', read, async (c) => {
  return c.json(await proformasService.costsView(c.get('session'), c.req.param('id')));
});

/** Servicios adicionales de la proforma: reemplaza el juego completo. */
proformasRoutes.put('/:id/costs', manage, zValidator('json', saveProformaCostsSchema), async (c) => {
  return c.json(
    await proformasService.saveCosts(c.get('session'), c.req.param('id'), c.req.valid('json')),
  );
});

proformasRoutes.post('/:id/approve', manage, async (c) => {
  await proformasService.approve(c.get('session'), c.req.param('id'));
  return c.json(await proformasService.get(c.req.param('id')));
});

proformasRoutes.post('/:id/correct', manage, zValidator('json', correctProformaSchema), async (c) => {
  return c.json(
    await proformasService.correct(c.get('session'), c.req.param('id'), c.req.valid('json')),
  );
});

/** Mover un tramite a otro borrador o a uno nuevo. Responde la proforma de destino. */
proformasRoutes.post(
  '/:id/shipments/:shipmentId/move',
  manage,
  zValidator('json', moveProformaShipmentSchema),
  async (c) => {
    return c.json(
      await proformasService.moveShipment(
        c.get('session'),
        c.req.param('id'),
        c.req.param('shipmentId'),
        c.req.valid('json'),
      ),
    );
  },
);

/** Reasignar un paquete del borrador a otro cliente (objetivo 7). */
proformasRoutes.post(
  '/:id/shipments/:shipmentId/reassign',
  manage,
  zValidator('json', assignShipmentOwnerSchema),
  async (c) => {
    return c.json(
      await proformasService.reassignShipment(
        c.get('session'),
        c.req.param('id'),
        c.req.param('shipmentId'),
        c.req.valid('json'),
      ),
    );
  },
);
