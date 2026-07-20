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
import { zValidator } from '@hono/zod-validator';
import { Permission, REPORT_DESCRIPTIONS, REPORT_LABELS, reportQuerySchema, reportsFor } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requireAnyPermission } from '../../core/middleware/requireAnyPermission';
import { requireSession } from '../../core/middleware/requireSession';
import { reportsService, toCsv } from './reports.service';

export const reportsRoutes = new Hono<AppEnv>();

reportsRoutes.use(
  '*',
  requireSession(),
  requireAnyPermission(
    Permission.ReportsOperationalBasic,
    Permission.ReportsOperationalFull,
    Permission.ReportsFinancial,
  ),
);

/** Reportes que el rol de la sesion puede generar; la pantalla arma el selector. */
reportsRoutes.get('/catalog', async (c) => {
  const kinds = reportsFor(c.get('session').role);
  return c.json({
    items: kinds.map((kind) => ({
      kind,
      label: REPORT_LABELS[kind],
      description: REPORT_DESCRIPTIONS[kind],
    })),
  });
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
