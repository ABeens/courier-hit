/**
 * Rutas del modulo de reportes.
 *
 * No hay `requirePermission` fijo: los tres niveles de reporte tienen permisos
 * distintos y cual aplica depende del `kind` que viene en la query. La barrera
 * vive en el servicio (`REPORT_PERMISSIONS`), que es quien conoce el reporte
 * pedido. Aqui solo se exige sesion y tener ALGUNO de los tres permisos, para
 * que el modulo no aparezca en el menu de quien no genera ningun reporte.
 */
import { Hono } from 'hono';
import { zValidator } from '../../core/validator';
import {
  Permission,
  REPORT_DESCRIPTIONS,
  REPORT_LABELS,
  can,
  proformaQuerySchema,
  reportQuerySchema,
  reportsFor,
} from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requireAnyPermission } from '../../core/middleware/requireAnyPermission';
import { requireSession } from '../../core/middleware/requireSession';
import { renderConsolidatedProformas, renderProformas } from './proforma.render';
import { proformaService } from './proforma.service';
import { reportsService, toCsv } from './reports.service';

export const reportsRoutes = new Hono<AppEnv>();

reportsRoutes.use(
  '*',
  requireSession(),
  requireAnyPermission(
    Permission.ReportsOperationalBasic,
    Permission.ReportsOperationalFull,
    Permission.ReportsFinancial,
    Permission.ReportsFull,
    Permission.ReportsOperational,
    Permission.ReportsProforma,
  ),
);

/**
 * Reportes que el rol de la sesion puede generar; la pantalla arma el selector.
 *
 * `proforma` viaja aparte de la lista porque no es un reporte: es otra accion
 * sobre el mismo filtro y con otro permiso. Se responde aqui para que la pantalla
 * no tenga que replicar la matriz de roles solo para decidir si pinta un boton.
 */
reportsRoutes.get('/catalog', async (c) => {
  const { role } = c.get('session');
  const kinds = reportsFor(role);
  return c.json({
    items: kinds.map((kind) => ({
      kind,
      label: REPORT_LABELS[kind],
      description: REPORT_DESCRIPTIONS[kind],
    })),
    proforma: can(role, Permission.ReportsProforma),
  });
});

/**
 * PROFORMAS. Van en este modulo y no en uno propio porque comparten los filtros
 * de alcance con los reportes y la misma pantalla las ofrece; lo que NO comparten
 * es la barrera, asi que el permiso lo comprueba el servicio (`ReportsProforma`),
 * igual que los reportes comprueban el suyo.
 *
 * Se devuelven como HTML y no como JSON ni CSV: una proforma es un documento que
 * se imprime o se manda, no una tabla que se filtra. Ver `proforma.render.ts`.
 */

/** Las que estan listas (tramites ya facturados), para poder contarlas antes de bajarlas. */
reportsRoutes.get('/proformas', zValidator('query', proformaQuerySchema), async (c) => {
  const items = await proformaService.ready(c.get('session'), c.req.valid('query'));
  return c.json({ items });
});

/** Todas las listas en UN documento, una por pagina. */
reportsRoutes.get('/proformas/document', zValidator('query', proformaQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const [proformas, omitted] = await Promise.all([
    proformaService.batch(c.get('session'), query),
    proformaService.omittedFrom(query),
  ]);
  return c.html(renderProformas(proformas, omitted));
});

/** La proforma de UN tramite. */
reportsRoutes.get('/proforma/:shipmentId', async (c) => {
  const proforma = await proformaService.get(c.get('session'), c.req.param('shipmentId'));
  return c.html(renderProformas([proforma]));
});

/**
 * PROFORMAS CONSOLIDADAS. Documento por COBRO AGRUPADO, no por tramite.
 *
 * Van por su propia ruta y no como un parametro de las de arriba porque la unidad
 * es otra: alli el id es un tramite y aqui un grupo de cobro. Los paquetes que
 * salen aqui NO salen en `/proformas` (`billedShipmentIds` los excluye), tal como
 * pide el requisito: un solo documento por el mismo dinero.
 *
 * Comparten los filtros de alcance y el permiso (`ReportsProforma`) con las
 * sueltas, y por eso viven en el mismo modulo y no en uno propio.
 */

/** Los cobros consolidados listos del filtro, para contarlos antes de bajarlos. */
reportsRoutes.get('/proformas/consolidadas', zValidator('query', proformaQuerySchema), async (c) => {
  const items = await proformaService.readyConsolidated(c.get('session'), c.req.valid('query'));
  return c.json({ items });
});

/** Todos los cobros consolidados del filtro en UN documento, uno por pagina. */
reportsRoutes.get(
  '/proformas/consolidadas/document',
  zValidator('query', proformaQuerySchema),
  async (c) => {
    const proformas = await proformaService.consolidatedBatch(c.get('session'), c.req.valid('query'));
    return c.html(renderConsolidatedProformas(proformas));
  },
);

/** La proforma de UN cobro consolidado. */
reportsRoutes.get('/proforma/consolidada/:groupId', async (c) => {
  const proforma = await proformaService.getConsolidated(c.get('session'), c.req.param('groupId'));
  return c.html(renderConsolidatedProformas([proforma]));
});

reportsRoutes.get('/', zValidator('query', reportQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const report = await reportsService.generate(c.get('session'), query);

  if (query.format !== 'csv') return c.json(report);

  return c.body(toCsv(report), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${query.kind}.csv"`,
  });
});
