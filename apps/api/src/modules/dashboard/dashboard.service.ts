/**
 * Resumen operativo (permiso dashboard.read): las colas de trabajo del dia.
 *
 * El resumen NO es una lista de metricas bonitas: es la respuesta a "¿que tengo
 * pendiente?" para cada rol operativo. Por eso las cifras que devuelve son
 * exactamente los estados sobre los que alguien tiene que actuar —facturar,
 * cobrar, repartir— y no un conteo de todo lo que existe.
 */
import { State } from '@courier/shared';
import { dashboardRepo } from './dashboard.repo';

export const dashboardService = {
  async summary() {
    const [byState, byType, pendingPayments, recent] = await Promise.all([
      dashboardRepo.countByState(),
      dashboardRepo.countByType(),
      dashboardRepo.pendingPaymentCount(),
      dashboardRepo.recent(),
    ]);

    const counts = new Map(byState.map((row) => [row.state, row.total]));
    const at = (state: State) => counts.get(state) ?? 0;

    return {
      /** Colas accionables, en el orden del flujo. */
      queues: [
        { state: State.Prealertado, label: 'Prealertados', total: at(State.Prealertado) },
        {
          state: State.FacturacionEnProceso,
          label: 'Por facturar',
          total: at(State.FacturacionEnProceso),
        },
        {
          state: State.EnBodegaPendientePago,
          label: 'Pendientes de pago',
          total: at(State.EnBodegaPendientePago),
        },
        { state: State.EnRutaEntrega, label: 'En ruta', total: at(State.EnRutaEntrega) },
        {
          state: State.DevueltoBodega,
          label: 'Devueltos a bodega',
          total: at(State.DevueltoBodega),
        },
      ],
      /** Depositos esperando validacion del staff. */
      pendingPayments,
      byType,
      byState,
      recent: recent.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    };
  },
};
