/**
 * Reglas de negocio de las entregas (Parte 5, rol Mensajeria).
 *
 * Tres decisiones que viven aqui y en ningun otro lado:
 *
 * 1. EL INTENTO Y EL ESTADO VAN JUNTOS. Registrar la visita y mover el tramite
 *    son un solo acto: un intento sin avance dejaria al paquete "en ruta" para
 *    siempre, y un avance sin intento perderia la prueba de la entrega.
 * 2. LA PRUEBA ES OBLIGATORIA Y SU REGLA VIVE EN SHARED. `proofRequirementFor`
 *    dice que exige cada desenlace; aqui solo se comprueba. Asi la web habilita
 *    el boton con el mismo criterio con el que la API acepta.
 * 3. EL AVANCE SALTA EL PERMISO DEL ESTADO DESTINO. Confirmar la entrega ES la
 *    autorizacion: al mensajero ya se le exigio delivery.manage para llegar aqui.
 *    Las guardas de DATOS de la maquina se aplican igual.
 */
import {
  Currency,
  DeliveryOutcome,
  MAX_DELIVERY_PHOTOS,
  State,
  chargeBasisFor,
  collectionStatus,
  isSettled,
  outstandingFor,
  paged,
  pendingAmount,
  proofRequirementFor,
  settledAmount,
  stateForOutcome,
} from '@courier/shared';
import type {
  DeliveryAttemptDto,
  DeliveryQueueFilter,
  ListDeliveryQueueQuery,
  RecordDeliveryAttemptInput,
  Session,
} from '@courier/shared';
import { DeliveryErrors, ShipmentErrors } from '../../core/errors';
import { StorageErrors, storage } from '../../core/storage';
import { shipmentsRepo } from '../shipments/shipments.repo';
import { transitionsService } from '../shipments/transitions.service';
import { deliveriesRepo } from './deliveries.repo';
import type {
  DeliveryReportDoc,
  DeliveryReportRoute,
  DeliveryReportRow,
} from './delivery-report.render';

/**
 * Tope de paradas de la hoja de ruta imprimible. No es un limite de paginacion:
 * es el freno de "todas las rutas" en un dia grande, para no armar un documento
 * de trescientas hojas que nadie imprime. Lo que deja fuera se anuncia.
 */
const REPORT_LIMIT = 500;

/** Fila de BD -> DTO de la API (fechas en ISO/UTC). */
function toDto(row: Awaited<ReturnType<typeof deliveriesRepo.listByShipment>>[number]): DeliveryAttemptDto {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    outcome: row.outcome,
    photoFileKeys: row.photoFileKeys,
    note: row.note,
    courierName: row.courierName,
    createdAt: row.createdAt.toISOString(),
  };
}

export const deliveriesService = {
  /** Una pagina de la cola del dia: lo que el mensajero tiene que repartir. */
  async queue(query: ListDeliveryQueueQuery) {
    const [rows, total] = await Promise.all([
      deliveriesRepo.queue(query),
      deliveriesRepo.countQueue(query),
    ]);
    /**
     * `settlement` no sale a la respuesta: son los abonos crudos, que el
     * mensajero no necesita (y que incluyen datos del cobro). Se reemplazan por
     * las dos cifras derivadas, las mismas que lleva el listado de tramites.
     */
    const items = rows.map(({ settlement, ...row }) => ({
      ...row,
      settledCrc: settledAmount(settlement, Currency.CRC),
      // En la moneda de cobro del tramite, la misma con la que la guarda de
      // salida a ruta responde esa pregunta (`chargeBasisFor`).
      settled: isSettled(settlement, chargeBasisFor(row.shipmentType, row)),
      pendingCrc: pendingAmount(settlement, Currency.CRC),
      /**
       * Los mismos abonos en dolares. Van SIEMPRE, igual que en el listado de
       * tramites: la bandera de cobro pregunta "¿esto ya esta en validacion?" en
       * la moneda en que se cobra, y en Paqueteria es esta.
       */
      settledUsd: settledAmount(settlement, Currency.USD),
      pendingUsd: pendingAmount(settlement, Currency.USD),
      updatedAt: row.updatedAt.toISOString(),
    }));
    return paged(items, total, query);
  },

  /**
   * La hoja de ruta imprimible de la cola: el MISMO filtro de la pantalla
   * (`DeliveryQueueFilter`) sobre el mismo orden, agrupado por ruta.
   *
   * Aqui no se pagina: el papel con el que sale el mensajero tiene que traer su
   * recorrido entero. El tope de `REPORT_LIMIT` es el freno de un filtro
   * demasiado abierto, y lo que deja fuera se compara contra el total y se
   * imprime en el documento.
   */
  async report(filter: DeliveryQueueFilter): Promise<DeliveryReportDoc> {
    const [rows, total] = await Promise.all([
      deliveriesRepo.queueAll(filter, REPORT_LIMIT),
      deliveriesRepo.countQueue(filter),
    ]);

    const routes: DeliveryReportRoute[] = [];
    for (const { settlement, ...row } of rows) {
      /**
       * El cobro se resuelve EN LA MONEDA EN QUE SE COBRA el trámite
       * (`chargeBasisFor`), no en colones por defecto: la Paqueteria se salda en
       * dolares, y un saldo de 40 impreso con el simbolo equivocado es el
       * mensajero cobrando cuarenta colones en la puerta.
       *
       * El estatus sale de `collectionStatus`, el mismo punto unico que usa el
       * reporte del administrador: el papel y la pantalla no pueden discrepar en
       * si un paquete esta pagado.
       */
      const basis = chargeBasisFor(row.shipmentType, row);
      const settled = settledAmount(settlement, basis.currency);

      const item: DeliveryReportRow = {
        ...row,
        collection: collectionStatus(settlement, basis),
        due: outstandingFor(settled, basis),
        dueCurrency: basis.currency,
      };

      /**
       * Las filas ya vienen ordenadas por ruta, asi que agrupar es mirar la
       * anterior. Se respeta ese orden en vez de reordenar por numero: es el
       * orden en que se arma el recorrido, y es el que el mensajero sigue.
       */
      const last = routes[routes.length - 1];
      if (last && last.routeNumber === item.routeNumber) last.rows.push(item);
      else routes.push({ routeNumber: item.routeNumber, rows: [item] });
    }

    return {
      // En UTC; el documento lo pasa a hora de Costa Rica al imprimirlo.
      generatedAt: new Date().toISOString(),
      filter,
      routes,
      total,
      omitted: Math.max(0, total - rows.length),
    };
  },

  /** Historial de intentos de un tramite. */
  async listByShipment(shipmentId: string): Promise<{ items: DeliveryAttemptDto[] }> {
    const rows = await deliveriesRepo.listByShipment(shipmentId);
    return { items: rows.map(toDto) };
  },

  /**
   * Registra el desenlace de una visita y mueve el tramite en consecuencia.
   *
   * El orden importa: primero se guardan los archivos, luego se escribe el
   * intento y al final se avanza el estado. Si el avance falla (una guarda de la
   * maquina no se cumple) queda el intento con su prueba y el tramite sin mover,
   * que es el estado del que un operador puede salir. Al reves habriamos avanzado
   * un tramite del que no queda constancia de por que.
   *
   * Las fotos son hasta `MAX_DELIVERY_PHOTOS` y se suben en SERIE, no en
   * paralelo: quien registra esto esta en la calle con datos moviles, y tres
   * subidas a la vez se estorban entre ellas mas de lo que se adelantan.
   */
  async record(
    session: Session,
    shipmentId: string,
    input: RecordDeliveryAttemptInput,
    photos: File[],
  ) {
    const shipment = await shipmentsRepo.findById(shipmentId);
    if (!shipment) throw ShipmentErrors.notFound();

    // La cola del mensajero son los tramites en ruta; registrar una visita sobre
    // cualquier otro es un error de la UI, no un caso de negocio.
    if (shipment.state !== State.EnRutaEntrega) throw DeliveryErrors.notInRoute();

    const required = proofRequirementFor(input.outcome);
    if (required.photo && photos.length === 0) throw DeliveryErrors.photoRequired();
    // El tope se comprueba SIEMPRE, no solo cuando la prueba es obligatoria: un
    // desenlace que no exige foto tampoco es sitio para subir veinte.
    if (photos.length > MAX_DELIVERY_PHOTOS) {
      throw DeliveryErrors.tooManyPhotos(MAX_DELIVERY_PHOTOS);
    }

    const photoFileKeys: string[] = [];
    for (const photo of photos) {
      photoFileKeys.push(await storage.put('deliveries', photo));
    }

    await deliveriesRepo.insert({
      shipmentId,
      outcome: input.outcome,
      photoFileKeys,
      note: input.note ?? null,
      courierId: session.userId,
    });

    /**
     * La nota del evento: en una devolucion es la razon que dio el mensajero
     * (Condition.RequiresComment la exige); en una entrega, una linea fija que
     * deja claro en el historial de donde salio el avance.
     */
    const note =
      input.outcome === DeliveryOutcome.DevueltoBodega
        ? input.note
        : photos.length > 1
          ? `Entrega confirmada con ${photos.length} fotos.`
          : 'Entrega confirmada con foto.';

    return transitionsService.transition(
      session,
      shipmentId,
      { state: stateForOutcome(input.outcome), note },
      { skipPermission: true },
    );
  },

  /**
   * Una foto de un intento, por su POSICION en el array. El indice es el
   * identificador porque las fotos no son entidades: no tienen id propio, y el
   * orden en que se subieron es estable (el intento es append-only y nunca se
   * edita).
   */
  async photoFile(attemptId: string, index: number) {
    const attempt = await deliveriesRepo.findById(attemptId);
    const key = attempt?.photoFileKeys[index];
    // 404 y no "falta la foto": pedir la tercera foto de un intento que subio dos
    // es pedir un archivo que no existe, no incumplir la regla de la prueba.
    if (!key) throw StorageErrors.notFound();
    return storage.get(key);
  },
};
