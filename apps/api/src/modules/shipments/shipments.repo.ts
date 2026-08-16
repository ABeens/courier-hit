/**
 * Acceso a datos de los tramites. Solo toca SUS tablas mas los joins de lectura
 * que necesitan los dashboards (cliente y ruta del distrito).
 *
 * La ruta operativa se resuelve con LEFT JOIN contra la definicion de rutas en
 * vez de copiarse a la fila del tramite: si el administrador reasigna la ruta de
 * un distrito o de un canton, los tramites en curso la reflejan sin migrar
 * datos. La precedencia entre los dos niveles vive en `routes/effective-route`.
 */
import { and, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { HelgaSyncStatus, toSlice } from '@courier/shared';
import type { ListShipmentsQuery, State } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { settlementColumn } from '../payments/settlement';
import { cantonRoutes } from '../routes/canton-route.schema';
import { districtRoutes } from '../routes/district-route.schema';
import { cantonRouteJoin, districtRouteJoin, effectiveRouteNumber } from '../routes/effective-route';
import { shipmentEvents, shipments } from './shipments.schema';

/** Columnas de la vista de lectura: el tramite + el cliente + la ruta. */
const columns = {
  id: shipments.id,
  code: shipments.code,
  shipmentType: shipments.shipmentType,
  state: shipments.state,
  tracking: shipments.tracking,
  description: shipments.description,
  store: shipments.store,
  carrier: shipments.carrier,
  hawb: shipments.hawb,
  weightKg: shipments.weightKg,
  declaredValueUsd: shipments.declaredValueUsd,
  insuredValueUsd: shipments.insuredValueUsd,
  tariffPosition: shipments.tariffPosition,
  retain: shipments.retain,
  documentFileKey: shipments.documentFileKey,
  warehouse: shipments.warehouse,
  dua: shipments.dua,
  billingNotes: shipments.billingNotes,
  electronicInvoiceNumber: shipments.electronicInvoiceNumber,
  invoiceTotalUsd: shipments.invoiceTotalUsd,
  invoiceTotalCrc: shipments.invoiceTotalCrc,
  /**
   * Abonos del tramite, para derivar la bandera de pago sin una consulta por
   * fila. Viajan crudos: la suma y el "ya esta cubierto" los resuelve el servicio
   * con las funciones de @courier/shared. Ver `payments/settlement.ts`.
   */
  settlement: settlementColumn,
  // Dimensiones que reporta el proveedor. Informativas: no entran en la factura.
  lengthCm: shipments.lengthCm,
  widthCm: shipments.widthCm,
  heightCm: shipments.heightCm,
  volumetricWeightKg: shipments.volumetricWeightKg,
  // Marca del congelamiento de factura: el candado de edicion del peso lo consulta.
  costsApprovedAt: shipments.costsApprovedAt,
  // Id de la prealerta en Helga: lo necesita el rehacer por cambio de tracking.
  helgaPrealertId: shipments.helgaPrealertId,
  // Archivado de la sala de control: null en todo tramite vivo.
  discardedAt: shipments.discardedAt,
  discardReason: shipments.discardReason,
  createdAt: shipments.createdAt,
  updatedAt: shipments.updatedAt,
  clientId: clients.id,
  clientCode: clients.code,
  clientName: users.name,
  routeNumber: effectiveRouteNumber,
};

/**
 * Consulta base con los joins de lectura; se le encadenan los filtros.
 *
 * El casillero entra con LEFT JOIN porque un paquete que llego a bodega sin dueño
 * todavia no tiene ninguno (`shipments.client_id` es nullable). Es el UNICO
 * lugar del sistema donde ese join se afloja: los demas modulos —panel, entregas,
 * reportes, notificaciones, sincronizacion con el proveedor— lo mantienen INNER y
 * asi dejan fuera solos a los paquetes sin dueño, que es exactamente lo que
 * necesitan (no se cotizan, no se cobran, no se entregan y no reciben correos).
 */
function baseQuery() {
  return db
    .select(columns)
    .from(shipments)
    .leftJoin(clients, eq(shipments.clientId, clients.id))
    .leftJoin(users, eq(clients.userId, users.id))
    .leftJoin(districtRoutes, districtRouteJoin)
    .leftJoin(cantonRoutes, cantonRouteJoin);
}

/**
 * Traduce los filtros del dashboard a condiciones SQL. `ownerClientId` lo pone
 * el servicio cuando la sesion es de un cliente: es la barrera de "lo propio" y
 * NO puede llegar desde la query del usuario.
 */
function buildConditions(query: ListShipmentsQuery, ownerClientId?: string): SQL[] {
  const conds: SQL[] = [];

  /**
   * Eje "archivado": o los vivos o los descartados, nunca los dos juntos. El
   * default esconde los descartados en TODAS las pantallas, incluida la que no
   * sabe que existen.
   */
  conds.push(query.discarded ? isNotNull(shipments.discardedAt) : isNull(shipments.discardedAt));

  /**
   * Eje "dueño". Sin filtro explicito se devuelven solo los que YA tienen dueño:
   * un paquete sin asignar no avanza ni se cobra, y colarlo en la cola de
   * operacion llenaria el tablero de filas inertes. La sala de control pide
   * 'unassigned' a proposito.
   */
  if (query.owner === 'unassigned') conds.push(isNull(shipments.clientId));
  else if (query.owner !== 'all') conds.push(isNotNull(shipments.clientId));

  if (ownerClientId) conds.push(eq(shipments.clientId, ownerClientId));
  if (query.clientId) conds.push(eq(shipments.clientId, query.clientId));
  if (query.state) conds.push(eq(shipments.state, query.state));
  if (query.shipmentType) conds.push(inArray(shipments.shipmentType, query.shipmentType));

  // Rango por fecha de ingreso: inicio inclusive, fin exclusivo (la web manda el
  // arranque del dia siguiente), asi el ultimo dia del rango entra completo.
  if (query.from) conds.push(gte(shipments.createdAt, new Date(query.from)));
  if (query.to) conds.push(lt(shipments.createdAt, new Date(query.to)));

  if (query.q) {
    const term = `%${query.q}%`;
    const match = or(
      ilike(shipments.code, term),
      ilike(shipments.tracking, term),
      ilike(shipments.description, term),
      ilike(clients.code, term),
      ilike(users.name, term),
    );
    if (match) conds.push(match);
  }

  return conds;
}

export const shipmentsRepo = {
  /**
   * Una PAGINA del listado filtrado, del mas reciente al mas antiguo.
   *
   * El desempate por `id` no es cosmetico: sin el, la paginacion se rompe. Los
   * lotes de la sincronizacion con el proveedor y de la recepcion se insertan
   * dentro de una transaccion, y `now()` da el mismo instante a toda la
   * transaccion, asi que `created_at` empatado es la norma y no la excepcion. Con
   * el orden ambiguo, Postgres puede devolver esas filas en distinto orden entre
   * dos peticiones y la misma fila sale en la pagina 1 y en la 2 mientras otra no
   * sale en ninguna.
   */
  async list(query: ListShipmentsQuery, ownerClientId?: string) {
    const conds = buildConditions(query, ownerClientId);
    const { limit, offset } = toSlice(query);
    return baseQuery()
      .where(and(...conds))
      .orderBy(desc(shipments.createdAt), desc(shipments.id))
      .limit(limit)
      .offset(offset);
  },

  /**
   * Cuantos tramites hay con esos filtros. Es el numero de la cabecera y el que
   * decide cuantas paginas existen, asi que corre SIEMPRE junto al listado.
   *
   * Se queda con los joins minimos: `clients` y `users` porque la busqueda `q`
   * mira el codigo de casillero y el nombre del titular, y nada mas. Fuera quedan
   * los dos joins de rutas (solo aportan una columna de presentacion) y, sobre
   * todo, `settlementColumn`, que es una subconsulta correlacionada por fila:
   * contar con ella dispararia un recorrido de `payments` por cada tramite del
   * filtro para no leer ni uno de los resultados.
   *
   * Los dos joins que quedan son LEFT sobre claves unicas, asi que no multiplican
   * filas y el conteo coincide exactamente con el del listado.
   */
  async countList(query: ListShipmentsQuery, ownerClientId?: string) {
    const conds = buildConditions(query, ownerClientId);
    const [row] = await db
      .select({ n: count() })
      .from(shipments)
      .leftJoin(clients, eq(shipments.clientId, clients.id))
      .leftJoin(users, eq(clients.userId, users.id))
      .where(and(...conds));
    return row?.n ?? 0;
  },

  /** Un tramite por id, con cliente y ruta. */
  async findById(id: string) {
    const [row] = await baseQuery().where(eq(shipments.id, id)).limit(1);
    return row ?? null;
  },

  /**
   * Tramite ACTIVO (no entregado ni descartado) con ese tracking, si existe.
   * Refleja el mismo criterio que el indice unico parcial: da un error claro
   * antes de chocar con la restriccion de la BD.
   */
  async findActiveByTracking(tracking: string) {
    const [row] = await db
      .select({ id: shipments.id, code: shipments.code })
      .from(shipments)
      .where(
        and(
          eq(shipments.tracking, tracking),
          sql`${shipments.state} <> 'entregado'`,
          isNull(shipments.discardedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  /**
   * Cuantos tramites del casillero siguen EN CURSO. Mismo criterio de "activo"
   * que `findActiveByTracking` y que el indice unico parcial: todo lo que no
   * llego a `entregado`, unico estado terminal de las tres maquinas. Incluye
   * `devuelto_bodega` a proposito: ese tramite vuelve a salir a ruta, asi que
   * todavia necesita una direccion estable.
   *
   * Lo consulta el candado de la direccion de entrega (`clientsService
   * .updateAddress`): la hoja del mensajero y la proforma leen la direccion del
   * casillero EN VIVO, no una copia congelada en el tramite, asi que moverla con
   * paquetes en curso les cambiaria el destino a mitad de camino.
   *
   * Se apoya en `shipments_client_created_idx` (le basta el prefijo `client_id`).
   */
  async countActiveByClient(clientId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(shipments)
      .where(and(eq(shipments.clientId, clientId), sql`${shipments.state} <> 'entregado'`));
    return row?.n ?? 0;
  },

  /**
   * Tramites ACTIVOS (no entregados) con ese HAWB (LES), el identificador que se
   * escanea en la mesa de bodega. Devuelve hasta dos: el HAWB no tiene indice
   * unico, asi que quien llama necesita poder distinguir "no hay" de "hay mas de
   * uno" en vez de quedarse con el primero que devuelva la BD.
   *
   * La comparacion ignora mayusculas: el HAWB que llega por el descubrimiento se
   * guarda tal como lo emite el proveedor, y no siempre en la misma caja que el
   * que se digita en la mesa. Sin indice que aprovechar, el `upper()` no cuesta
   * nada aqui.
   */
  async findActiveByHawb(hawb: string) {
    return db
      .select({ id: shipments.id, code: shipments.code })
      .from(shipments)
      .where(
        and(
          sql`upper(${shipments.hawb}) = upper(${hawb})`,
          sql`${shipments.state} <> 'entregado'`,
          // Un bulto descartado no reclama su LES: si vuelve a escanearse, lo que
          // hay que hacer es darlo de alta otra vez, no resucitar el archivado.
          isNull(shipments.discardedAt),
        ),
      )
      .limit(2);
  },

  /** Siguiente numero de la secuencia del consecutivo (el formato lo pone shared). */
  async nextCodeSequence(): Promise<string> {
    const rows = (await db.execute(
      sql`select nextval('hs_shipment_code_seq') as val`,
    )) as Array<{ val: string }>;
    const val = rows[0]?.val;
    if (!val) throw new Error('No se pudo generar el consecutivo del trámite.');
    return val;
  },

  /**
   * Inserta el tramite y su primer evento en la MISMA transaccion: un tramite sin
   * historial seria un registro sin trazabilidad desde su origen.
   *
   * `note` la usa el alta que necesita explicar POR QUE el tramite nace donde
   * nace: el paquete sin dueño de la sala de control no arranca en "Prealertado"
   * como los demas, y sin esa linea el historial empezaria en mitad del flujo sin
   * decir de donde salio.
   */
  async insert(values: typeof shipments.$inferInsert, note?: string) {
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(shipments).values(values).returning({ id: shipments.id });
      if (!row) throw new Error('No se pudo crear el trámite.');
      await tx.insert(shipmentEvents).values({
        shipmentId: row.id,
        state: values.state,
        note: note ?? null,
        createdBy: values.createdBy ?? null,
      });
      return row.id;
    });
  },

  /**
   * Escribe el dueño del tramite y deja el asiento del cambio en el historial,
   * las dos cosas en la MISMA transaccion.
   *
   * El evento repite el estado ACTUAL: el paquete no se movio, cambio de manos.
   * Es la unica forma de dejar rastro sin inventar un estado que la maquina no
   * conoce, y encaja con la convencion que ya existia para las enmiendas (la nota
   * lleva `CORRECTION_NOTE_PREFIX`, que es lo que hace que el titular no la vea).
   */
  async assignOwner(id: string, state: State, clientId: string, userId: string, note: string) {
    await db.transaction(async (tx) => {
      await tx
        .update(shipments)
        .set({ clientId, updatedAt: new Date() })
        .where(eq(shipments.id, id));
      await tx.insert(shipmentEvents).values({ shipmentId: id, state, note, createdBy: userId });
    });
  },

  /**
   * Archiva (o desarchiva) un paquete sin dueño, con su asiento en el historial.
   * `reason` null = restaurar: se limpian las tres columnas del descarte para que
   * el tramite vuelva a ser indistinguible de uno que nunca se archivo.
   */
  async setDiscarded(
    id: string,
    state: State,
    userId: string,
    reason: string | null,
    note: string,
  ) {
    await db.transaction(async (tx) => {
      await tx
        .update(shipments)
        .set({
          discardedAt: reason === null ? null : new Date(),
          discardedBy: reason === null ? null : userId,
          discardReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(shipments.id, id));
      await tx.insert(shipmentEvents).values({ shipmentId: id, state, note, createdBy: userId });
    });
  },

  async update(id: string, patch: Partial<typeof shipments.$inferInsert>) {
    const [row] = await db
      .update(shipments)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(shipments.id, id))
      .returning({ id: shipments.id });
    return row ?? null;
  },

  /**
   * Prealertas que el robot debe reenviar al proveedor: las que quedaron
   * 'pending' (Helga apagado o casillero sin enlazar al prealertar) o 'failed', y
   * cuyo casillero YA esta enlazado (sin `helgaClientId` no hay destinatario a
   * quien prealertar). Orden por antiguedad y con tope, como el reconcile del
   * casillero.
   */
  async findPrealertsToReconcile(limit: number) {
    return db
      .select({
        id: shipments.id,
        code: shipments.code,
        tracking: shipments.tracking,
        description: shipments.description,
        store: shipments.store,
        declaredValueUsd: shipments.declaredValueUsd,
        insuredValueUsd: shipments.insuredValueUsd,
        tariffPosition: shipments.tariffPosition,
        retain: shipments.retain,
        attempts: shipments.helgaPrealertAttempts,
        helgaClientId: sql<string>`${clients.helgaClientId}`,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .where(
        and(
          inArray(shipments.helgaPrealertStatus, [HelgaSyncStatus.Pending, HelgaSyncStatus.Failed]),
          isNotNull(clients.helgaClientId),
        ),
      )
      .orderBy(shipments.createdAt)
      .limit(limit);
  },

  /**
   * Mueve el tramite a un estado nuevo dejando su rastro en el historial. Las dos
   * escrituras van en la MISMA transaccion: un cambio de estado sin evento seria
   * un salto sin trazabilidad. La validez de la transicion la decide la maquina
   * de estados (en el servicio), no esta funcion.
   */
  async transition(id: string, state: State, createdBy: string, note?: string) {
    await db.transaction(async (tx) => {
      await tx.update(shipments).set({ state, updatedAt: new Date() }).where(eq(shipments.id, id));
      await tx.insert(shipmentEvents).values({
        shipmentId: id,
        state,
        note: note ?? null,
        createdBy,
      });
    });
  },

  /** Historial de estados, del mas antiguo al mas reciente (orden del timeline). */
  async listEvents(shipmentId: string) {
    return db
      .select({
        id: shipmentEvents.id,
        state: shipmentEvents.state,
        note: shipmentEvents.note,
        createdAt: shipmentEvents.createdAt,
        createdByName: users.name,
      })
      .from(shipmentEvents)
      .leftJoin(users, eq(shipmentEvents.createdBy, users.id))
      .where(eq(shipmentEvents.shipmentId, shipmentId))
      .orderBy(shipmentEvents.createdAt);
  },
};
