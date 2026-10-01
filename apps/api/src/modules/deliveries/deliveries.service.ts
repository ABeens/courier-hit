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
  Flow,
  MAX_DELIVERY_PHOTOS,
  State,
  CollectionStatus,
  chargeBasisFor,
  collectionStatus,
  isSettled,
  outstandingFor,
  paged,
  toSlice,
  pendingAmount,
  proofRequirementFor,
  roundMoney,
  settledAmount,
  stateForOutcome,
} from '@courier/shared';
import type {
  DeliveryAttemptDto,
  DeliveryQueueFilter,
  ListDeliveryQueueQuery,
  RecordDeliveryAttemptInput,
  RecordProformaDeliveryInput,
  Session,
} from '@courier/shared';
import { DeliveryErrors, ProformaErrors, ShipmentErrors } from '../../core/errors';
import { StorageErrors, storage } from '../../core/storage';
import { proformasRepo } from '../proformas/proformas.repo';
import { shipmentsRepo } from '../shipments/shipments.repo';
import { transitionsService } from '../shipments/transitions.service';
import { deliveriesRepo } from './deliveries.repo';
import type {
  DeliveryReportClient,
  DeliveryReportDoc,
  DeliveryReportRoute,
  DeliveryReportRow,
  DeliveryReportStop,
} from './delivery-report.render';

/**
 * Tope de paradas de la hoja de ruta imprimible. No es un limite de paginacion:
 * es el freno de "todas las rutas" en un dia grande, para no armar un documento
 * de trescientas hojas que nadie imprime. Lo que deja fuera se anuncia.
 */
const REPORT_LIMIT = 500;

/**
 * Tope de paquetes que se agrupan para la cola por proforma. La cola se agrupa en
 * memoria (una proforma puede tener paquetes en paginas distintas de la consulta
 * por paquete), asi que se lee entera hasta este freno, como la hoja de ruta.
 */
const STOPS_LIMIT = 2000;

/** Paquetes de la proforma por estado: lo que la tarjeta cuenta ademas de lo que va en ruta. */
export interface DeliveryStopCounts {
  total: number;
  inRoute: number;
  inWarehouse: number;
  delivered: number;
  returned: number;
}

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
   * La cola AGRUPADA POR CLIENTE y, dentro, POR PROFORMA: una tarjeta por
   * cliente con sus proformas, cada una con sus paquetes en ruta y los conteos
   * de la proforma entera (para avisar si algo sigue en bodega). Cada proforma
   * se entrega por separado; un paquete en ruta sin proforma (anterior al
   * modulo) es su propia entrada dentro del cliente. Mismo filtro y mismo orden
   * que la cola por paquete; se pagina por CLIENTE, para que ni un cliente ni
   * una proforma queden partidos en dos paginas.
   */
  async stops(query: ListDeliveryQueueQuery) {
    const page = await this.queue({ ...query, page: 1, pageSize: STOPS_LIMIT });
    type Item = (typeof page.items)[number];
    interface Stop {
      proformaId: string | null;
      proformaNumber: number | null;
      shipments: Item[];
    }
    const clientsById = new Map<string, { clientId: string; stops: Map<string, Stop> }>();
    for (const item of page.items) {
      let client = clientsById.get(item.clientId);
      if (!client) {
        client = { clientId: item.clientId, stops: new Map() };
        clientsById.set(item.clientId, client);
      }
      const key = item.proformaId ?? `shipment:${item.id}`;
      let stop = client.stops.get(key);
      if (!stop) {
        stop = { proformaId: item.proformaId, proformaNumber: item.proformaNumber, shipments: [] };
        client.stops.set(key, stop);
      }
      stop.shipments.push(item);
    }
    const all = [...clientsById.values()].map((c) => ({ clientId: c.clientId, stops: [...c.stops.values()] }));
    const { limit, offset } = toSlice(query);
    const slice = all.slice(offset, offset + limit);

    const ids = slice
      .flatMap((c) => c.stops.map((s) => s.proformaId))
      .filter((id): id is string => id !== null);
    const rows = await deliveriesRepo.proformaStateCounts(ids);
    const countsOf = (proformaId: string): DeliveryStopCounts => {
      const own = rows.filter((r) => r.proformaId === proformaId);
      const of = (state: State) => own.find((r) => r.state === state)?.n ?? 0;
      return {
        total: own.reduce((n, r) => n + r.n, 0),
        inRoute: of(State.EnRutaEntrega),
        inWarehouse: of(State.EnBodegaPendientePago),
        delivered: of(State.Entregado),
        returned: of(State.DevueltoBodega),
      };
    };

    const items = slice.map((c) => ({
      clientId: c.clientId,
      stops: c.stops.map((s) => ({
        ...s,
        counts: s.proformaId ? countsOf(s.proformaId) : null,
      })),
    }));
    const proformasInRoute = all.reduce((n, c) => n + c.stops.length, 0);
    return { ...paged(items, all.length, query), packagesInRoute: page.total, proformasInRoute };
  },

  /**
   * La hoja de ruta imprimible de la cola: el MISMO filtro de la pantalla
   * (`DeliveryQueueFilter`) sobre el mismo orden, agrupado por ruta, dentro de
   * cada ruta por cliente y, dentro del cliente, por proforma (como la pantalla).
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
    /** Cliente ya abierto, por ruta y cliente. */
    const clientsByKey = new Map<string, DeliveryReportClient>();
    /** Proforma ya abierta, por ruta, cliente y proforma. */
    const stopsByKey = new Map<string, DeliveryReportStop>();
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
      let route = routes[routes.length - 1];
      if (!route || route.routeNumber !== item.routeNumber) {
        route = { routeNumber: item.routeNumber, clients: [], packages: 0 };
        routes.push(route);
      }
      route.packages += 1;

      /**
       * Dentro de la ruta, UNA PARADA POR CLIENTE con sus proformas: la visita es
       * a una puerta, y cada proforma se entrega y se firma por separado
       * (`recordProforma`), igual que en la pantalla. Un paquete sin proforma
       * (anterior al modulo) es su propia entrada dentro del cliente. El repo ya
       * trae juntos al cliente y sus proformas; los mapas son para no depender
       * de eso.
       */
      const clientKey = `${item.routeNumber ?? '-'}|${item.clientId}`;
      let client = clientsByKey.get(clientKey);
      if (!client) {
        client = { clientId: item.clientId, stops: [] };
        clientsByKey.set(clientKey, client);
        route.clients.push(client);
      }
      const key = `${clientKey}|${item.proformaId ?? `shipment:${item.id}`}`;
      let stop = stopsByKey.get(key);
      if (!stop) {
        stop = { proformaNumber: item.proformaNumber, rows: [], dueTotals: [] };
        stopsByKey.set(key, stop);
        client.stops.push(stop);
      }
      stop.rows.push(item);
    }

    /**
     * El saldo de cada proforma es lo que se cobra en la puerta, por moneda: se
     * suman las mismas filas que imprimen cifra (pendiente o en validacion), y
     * cada total pasa por `roundMoney` (regla M4) para no arrastrar decimales de
     * float.
     */
    for (const route of routes) {
      for (const stop of route.clients.flatMap((c) => c.stops)) {
        const totals = new Map<Currency, number>();
        for (const r of stop.rows) {
          if (r.collection === CollectionStatus.Pagado || r.collection === CollectionStatus.SinFacturar) continue;
          if (r.due <= 0) continue;
          totals.set(r.dueCurrency, (totals.get(r.dueCurrency) ?? 0) + r.due);
        }
        stop.dueTotals = [...totals].map(([currency, amount]) => ({
          currency,
          amount: roundMoney(amount, currency),
        }));
      }
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
   * Registra la ENTREGA DE UNA PROFORMA de Paqueteria: una visita del mensajero
   * (decisiones D4, P6 y P14).
   *
   *   - Los paquetes entregados pasan a Entregado; los devueltos, con su motivo, a
   *     Devuelto a bodega. Los que no se marcan siguen "En ruta de entrega" y se
   *     confirman despues, uno por uno (regla 13 del SOW).
   *   - Las fotos son de la ENTREGA, no del paquete: se suben una vez (1 a 10) y
   *     cada paquete entregado en esta visita las lleva como prueba.
   *
   * Todo se valida ANTES de subir fotos o mover nada: una visita a medio registrar
   * (tres paquetes entregados y el cuarto con error) no se puede explicar despues.
   */
  async recordProforma(
    session: Session,
    proformaId: string,
    input: RecordProformaDeliveryInput,
    photos: File[],
  ) {
    const proforma = await proformasRepo.findById(proformaId);
    if (!proforma) throw ProformaErrors.notFound();
    if (proforma.flow !== Flow.Paqueteria) throw DeliveryErrors.notDeliverableFlow();

    const shipments = await proformasRepo.shipmentsOf(proformaId);
    const byId = new Map(shipments.map((s) => [s.id, s]));
    const marked = [...input.delivered, ...input.returned.map((r) => r.shipmentId)];
    for (const id of marked) {
      const shipment = byId.get(id);
      if (!shipment) throw DeliveryErrors.shipmentNotInProforma();
      if (shipment.state !== State.EnRutaEntrega) throw DeliveryErrors.shipmentNotInRoute(shipment.code);
    }

    if (input.delivered.length > 0 && photos.length === 0) throw DeliveryErrors.photoRequired();
    if (photos.length > MAX_DELIVERY_PHOTOS) throw DeliveryErrors.tooManyPhotos(MAX_DELIVERY_PHOTOS);

    // En serie y no en paralelo: quien sube esto esta en la calle con datos moviles.
    const photoFileKeys: string[] = [];
    for (const photo of photos) photoFileKeys.push(await storage.put('deliveries', photo));

    const deliveredNote =
      photos.length > 1 ? `Entrega de la proforma con ${photos.length} fotos.` : 'Entrega de la proforma con foto.';

    for (const id of input.delivered) {
      await deliveriesRepo.insert({
        shipmentId: id,
        outcome: DeliveryOutcome.Entregado,
        photoFileKeys,
        note: null,
        courierId: session.userId,
      });
      await transitionsService.transition(
        session,
        id,
        { state: State.Entregado, note: deliveredNote },
        { skipPermission: true },
      );
    }

    for (const { shipmentId, reason } of input.returned) {
      await deliveriesRepo.insert({
        shipmentId,
        outcome: DeliveryOutcome.DevueltoBodega,
        photoFileKeys: [],
        note: reason,
        courierId: session.userId,
      });
      await transitionsService.transition(
        session,
        shipmentId,
        { state: State.DevueltoBodega, note: reason },
        { skipPermission: true },
      );
    }

    return { proformaId, delivered: input.delivered.length, returned: input.returned.length };
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
