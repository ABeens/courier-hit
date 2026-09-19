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
    const [byState, byType, pendingPayments, recent, billedInBilling] = await Promise.all([
      dashboardRepo.countByState(),
      dashboardRepo.countByType(),
      dashboardRepo.pendingPaymentCount(),
      dashboardRepo.recent(),
      dashboardRepo.billedInBillingCount(),
    ]);

    const counts = new Map(byState.map((row) => [row.state, row.total]));
    const at = (state: State) => counts.get(state) ?? 0;

    return {
      /** Colas accionables, en el orden del flujo. */
      queues: [
        { state: State.Prealertado, label: 'Prealertados', total: at(State.Prealertado) },
        /**
         * Lo que falta facturar, sin los de Transporte que ya se facturaron y
         * comparten estado (ver `billedInBillingCount`). La cifra tiene que ser
         * la misma que ensena la cola de Costos a la que lleva el cuadro.
         */
        {
          state: State.FacturacionEnProceso,
          label: 'Por facturar',
          total: at(State.FacturacionEnProceso) - billedInBilling,
        },
        /**
         * Entregado sin facturar: solo Transporte. La mercaderia ya salio y
         * nadie le ha cargado los costos, que es plata en la calle sin
         * documentar. Va antes que las colas de cobro porque es la que se
         * atasca en silencio: el tramite no molesta a nadie hasta que alguien
         * pregunta por que no se ha cobrado.
         */
        {
          state: State.EntregadoPendientePago,
          label: 'Entregados sin facturar',
          total: at(State.EntregadoPendientePago),
        },
        {
          state: State.EnBodegaPendientePago,
          label: 'Pendientes de pago',
          total: at(State.EnBodegaPendientePago),
        },
        /**
         * La proforma de Agenciamiento esperando el pago. Es una cola de cobro
         * propia y no se suma a la de arriba porque bloquea algo distinto: sin
         * pagar, el tramite no entra a aduana.
         */
        {
          state: State.ProformaPendientePago,
          label: 'Proformas por cobrar',
          total: at(State.ProformaPendientePago),
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
