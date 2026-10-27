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
  reportQuerySchema,
  reportsFor,
} from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requireAnyPermission } from '../../core/middleware/requireAnyPermission';
import { requireSession } from '../../core/middleware/requireSession';
import { reportsService } from './reports.service';
import { renderReportXlsx } from './reports.xlsx';

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
  ),
);

/** Reportes que el rol de la sesion puede generar; la pantalla arma el selector. */
reportsRoutes.get('/catalog', async (c) => {
  const { role } = c.get('session');
  const kinds = reportsFor(role);
  return c.json({
    items: kinds.map((kind) => ({
      kind,
      label: REPORT_LABELS[kind],
      description: REPORT_DESCRIPTIONS[kind],
    })),
  });
});

/*
 * Las PROFORMAS ya no se descargan desde aqui: pasaron a ser un modulo propio
 * (`/api/proformas`), con su bandeja, su documento y su exportacion.
 */

reportsRoutes.get('/', zValidator('query', reportQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const report = await reportsService.generate(c.get('session'), query);

  if (query.format !== 'xlsx') return c.json(report);

  return c.body(await renderReportXlsx(report), 200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="${query.kind}.xlsx"`,
  });
});
