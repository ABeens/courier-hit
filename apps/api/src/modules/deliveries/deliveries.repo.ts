/**
 * Acceso a datos del modulo de entregas. Dueño de `delivery_attempts`; lee
 * `shipments` + `clients` + `users` + la definicion de rutas para armar la cola
 * del mensajero (que necesita saber a nombre de quien va y por que ruta).
 */
import { and, asc, count, eq, ilike, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { State, toSlice } from '@courier/shared';
import type { DeliveryQueueFilter, ListDeliveryQueueQuery } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { settlementColumn } from '../payments/settlement';
import { cantonRoutes } from '../routes/canton-route.schema';
import { districtRoutes } from '../routes/district-route.schema';
import { cantonRouteJoin, districtRouteJoin, effectiveRouteNumber } from '../routes/effective-route';
import { shipments } from '../shipments/shipments.schema';
import { deliveryAttempts } from './deliveries.schema';

/**
 * Filtros de la cola, en SQL. El estado NO es negociable: es la definicion de la
 * cola (Parte 5), asi que va fijo y no se puede aflojar desde la query. Los otros
 * dos (ruta y busqueda) son los del manual, y se aplican aqui y no sobre lo ya
 * cargado porque el listado viene paginado.
 */
function queueConditions(query: DeliveryQueueFilter): SQL[] {
  const conds: SQL[] = [eq(shipments.state, State.EnRutaEntrega)];

  if (query.routeNumber !== undefined) {
    conds.push(eq(effectiveRouteNumber, query.routeNumber));
  }
  if (query.q) {
    const term = `%${query.q}%`;
    const match = or(
      ilike(users.name, term),
      ilike(shipments.tracking, term),
      ilike(shipments.code, term),
    );
    if (match) conds.push(match);
  }

  return conds;
}

/**
 * La consulta de la cola, sin recorte. La comparten la pagina que lee el
 * mensajero en el telefono y la hoja de ruta que se imprime: mismas columnas,
 * mismos filtros y mismo orden, y lo unico que cada una decide es cuantas filas
 * se lleva. Si se hubiera escrito dos veces, el papel y la pantalla podrian
 * discrepar en lo que es el mismo recorrido.
 */
function queueQuery(query: DeliveryQueueFilter) {
  return db
    .select({
      id: shipments.id,
      code: shipments.code,
      tracking: shipments.tracking,
      /**
       * HAWB (LES): el identificador que le pone la bodega de Miami y el que va
       * IMPRESO en la etiqueta de la caja. Va junto al tracking y nunca en su
       * lugar: el mensajero tiene delante la etiqueta, no el numero de la tienda.
       */
      hawb: shipments.hawb,
      description: shipments.description,
      shipmentType: shipments.shipmentType,
      clientName: users.name,
      clientPhone: users.phone,
      provinceCode: clients.provinceCode,
      cantonCode: clients.cantonCode,
      districtCode: clients.districtCode,
      addressLine: clients.addressLine,
      routeNumber: effectiveRouteNumber,
      /**
       * Los DOS totales congelados. El de dolares no se pinta en la cola: hace
       * falta para saber si el paquete esta pagado, porque la Paqueteria se
       * cobra y se salda en dolares (`chargeBasisFor`).
       */
      invoiceTotalUsd: shipments.invoiceTotalUsd,
      invoiceTotalCrc: shipments.invoiceTotalCrc,
      /**
       * Abonos del tramite: el mensajero tiene que ver si sale con un paquete
       * sin cobrar. Crudos, como en el listado de tramites; la suma la hace el
       * servicio con @courier/shared (ver `payments/settlement.ts`).
       */
      settlement: settlementColumn,
      updatedAt: shipments.updatedAt,
    })
    .from(shipments)
    .innerJoin(clients, eq(shipments.clientId, clients.id))
    .innerJoin(users, eq(clients.userId, users.id))
    .leftJoin(districtRoutes, districtRouteJoin)
    .leftJoin(cantonRoutes, cantonRouteJoin)
    .where(and(...queueConditions(query)))
    /**
     * Por ruta y luego por antiguedad: es el orden en que se arma un recorrido.
     * El `id` cierra la clave porque los otros dos empatan con facilidad (media
     * ruta puede pasar a "en ruta" en la misma operacion, con el mismo
     * `updated_at`), y con orden ambiguo la paginacion repite filas.
     */
    .orderBy(asc(effectiveRouteNumber), asc(shipments.updatedAt), asc(shipments.id));
}

export const deliveriesRepo = {
  /**
   * Cola del mensajero: los tramites "En ruta de entrega". El estado NO es un
   * filtro opcional, es la definicion de la cola (Parte 5: "todos los paquetes
   * que se encuentren en el estado Ruta de Entrega"), asi que va fijo y no se
   * puede aflojar desde la query.
   */
  async queue(query: ListDeliveryQueueQuery) {
    const { limit, offset } = toSlice(query);
    return queueQuery(query).limit(limit).offset(offset);
  },

  /**
   * La cola ENTERA del filtro, para la hoja de ruta imprimible. No se pagina
   * porque un documento que dice "ruta 4" y trae las primeras 50 de 130 paradas
   * es peor que no tenerlo: el mensajero sale a la calle creyendo que termino.
   *
   * El tope existe igual, como freno de un filtro demasiado abierto; quien lo
   * llama compara contra el total y avisa impreso lo que se quedo fuera.
   */
  async queueAll(query: DeliveryQueueFilter, limit: number) {
    return queueQuery(query).limit(limit);
  },

  /**
   * Cuantos paquetes hay en la cola con esos filtros. Conserva los joins de ruta
   * porque `routeNumber` filtra sobre la ruta EFECTIVA, que sale de ellos; deja
   * fuera `settlementColumn`, que es una subconsulta correlacionada por fila.
   */
  async countQueue(query: DeliveryQueueFilter) {
    const [row] = await db
      .select({ n: count() })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .leftJoin(districtRoutes, districtRouteJoin)
      .leftJoin(cantonRoutes, cantonRouteJoin)
      .where(and(...queueConditions(query)));
    return row?.n ?? 0;
  },

  /** Intentos de un tramite, del mas antiguo al mas reciente. */
  async listByShipment(shipmentId: string) {
    return db
      .select({
        id: deliveryAttempts.id,
        shipmentId: deliveryAttempts.shipmentId,
        outcome: deliveryAttempts.outcome,
        photoFileKeys: deliveryAttempts.photoFileKeys,
        note: deliveryAttempts.note,
        createdAt: deliveryAttempts.createdAt,
        courierName: users.name,
      })
      .from(deliveryAttempts)
      .leftJoin(users, eq(deliveryAttempts.courierId, users.id))
      .where(eq(deliveryAttempts.shipmentId, shipmentId))
      .orderBy(asc(deliveryAttempts.createdAt));
  },

  async findById(id: string) {
    const [row] = await db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.id, id))
      .limit(1);
    return row ?? null;
  },

  async insert(values: typeof deliveryAttempts.$inferInsert) {
    const [row] = await db
      .insert(deliveryAttempts)
      .values(values)
      .returning({ id: deliveryAttempts.id });
    if (!row) throw new Error('No se pudo registrar el intento de entrega.');
    return row.id;
  },
};
