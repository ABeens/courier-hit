/**
 * Arranque: monta los modulos bajo /api y levanta el servidor (docs/02-api.md §4).
 */
import { serve } from '@hono/node-server';
import { config } from './core/config';
import { createApp } from './core/http';
import { authRoutes } from './modules/auth/auth.routes';
import { usersRoutes } from './modules/users/users.routes';
import { costServicesRoutes } from './modules/cost-services/cost-services.routes';
import { costsRoutes } from './modules/costs/costs.routes';
import { tariffsRoutes } from './modules/tariffs/tariffs.routes';
import { routesRoutes } from './modules/routes/routes.routes';
import { clientsRoutes } from './modules/clients/clients.routes';
import { shipmentsRoutes } from './modules/shipments/shipments.routes';
import { announcementsRoutes } from './modules/announcements/announcements.routes';
import { paymentsRoutes } from './modules/payments/payments.routes';
import { deliveriesRoutes } from './modules/deliveries/deliveries.routes';
import { reportsRoutes } from './modules/reports/reports.routes';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes';

const app = createApp();
app.route('/api/auth', authRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/cost-services', costServicesRoutes);
app.route('/api/costs', costsRoutes);
app.route('/api/tariffs', tariffsRoutes);
app.route('/api/routes', routesRoutes);
app.route('/api/clients', clientsRoutes);
app.route('/api/shipments', shipmentsRoutes);
app.route('/api/announcements', announcementsRoutes);
app.route('/api/payments', paymentsRoutes);
app.route('/api/deliveries', deliveriesRoutes);
app.route('/api/reports', reportsRoutes);
app.route('/api/dashboard', dashboardRoutes);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[api] escuchando en http://localhost:${info.port}`);
});

export { app };
