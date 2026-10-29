/**
 * Resumen operativo (permiso dashboard.read): las colas de trabajo del dia.
 *
 * El resumen NO es una lista de metricas bonitas: es la respuesta a "¿que tengo
 * pendiente?" para cada rol operativo. Por eso las cifras que devuelve son
 * exactamente los estados sobre los que alguien tiene que actuar —facturar,
 * cobrar, repartir— y no un conteo de todo lo que existe.
 */
import { Flow, ProformaStatus, State } from '@courier/shared';
import { dashboardRepo } from './dashboard.repo';

export const dashboardService = {
  async summary() {
    const [byState, byType, pendingPayments, recent, drafts, agencyUnpaid, transportUnpaid] =
      await Promise.all([
        dashboardRepo.countByState(),
        dashboardRepo.countByType(),
        dashboardRepo.pendingPaymentCount(),
        dashboardRepo.recent(),
        dashboardRepo.proformaCount(ProformaStatus.Borrador),
        dashboardRepo.proformaCount(ProformaStatus.Aprobada, Flow.Agenciamiento),
        dashboardRepo.proformaCount(ProformaStatus.Aprobada, Flow.Transporte),
      ]);

    const counts = new Map(byState.map((row) => [row.state, row.total]));
    const at = (state: State) => counts.get(state) ?? 0;

    return {
      /**
       * Colas accionables, en el orden del flujo. Cuando el estado es de un solo
       * flujo, la etiqueta lo nombra ("Paquetes...", "Transporte...",
       * "Agenciamiento..."): sin eso el cuadro no dice de que trámites habla.
       */
      queues: [
        { state: State.Prealertado, label: 'Prealertados', total: at(State.Prealertado) },
        /**
         * Lo que falta facturar, contado en PROFORMAS en borrador (de los tres
         * flujos) y no en tramites: el cuadro lleva a esa bandeja, y Paqueteria
         * agrupa los paquetes de un cliente en un solo borrador. `state` queda
         * como clave del cuadro (tono, destino), no como lo que se cuenta.
         */
        {
          state: State.FacturacionEnProceso,
          label: 'Proformas por aprobar',
          total: drafts,
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
          label: 'Transporte entregado sin facturar',
          total: at(State.EntregadoPendientePago),
        },
        {
          state: State.EnBodegaPendientePago,
          label: 'Paquetes pendientes de pago',
          total: at(State.EnBodegaPendientePago),
        },
        /**
         * Las proformas de Agenciamiento aprobadas esperando el pago. Es una
         * cola de cobro propia y no se suma a la de arriba porque bloquea algo
         * distinto: sin pagar, el tramite no entra a aduana. Cuenta proformas,
         * igual que la bandeja a la que lleva (mismo motivo que la de arriba).
         */
        {
          state: State.ProformaPendientePago,
          label: 'Agenciamiento por cobrar',
          total: agencyUnpaid,
        },
        { state: State.EnRutaEntrega, label: 'Paquetes en ruta', total: at(State.EnRutaEntrega) },
        {
          state: State.DevueltoBodega,
          label: 'Paquetes devueltos a bodega',
          total: at(State.DevueltoBodega),
        },
      ],
      /**
       * Proformas de Transporte aprobadas y sin pagar. Va aparte de `queues`
       * porque no es un estado del tramite: Transporte cobra sin salir de
       * "Facturacion en proceso", y sin esta cifra ese cobro no salia en
       * ningun cuadro.
       */
      transportUnpaid,
      /** Proformas con un pago esperando validacion del administrador. */
      pendingPayments,
      byType,
      byState,
      recent: recent.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    };
  },
};
