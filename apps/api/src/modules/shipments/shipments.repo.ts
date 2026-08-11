/**
 * Acceso a datos de los tramites. Solo toca SUS tablas mas los joins de lectura
 * que necesitan los dashboards (cliente y ruta del distrito).
 *
 * La ruta operativa se resuelve con un LEFT JOIN contra `district_routes` en vez
 * de copiarse a la fila del tramite: si el administrador reasigna la ruta de un
 * distrito, los tramites en curso la reflejan sin migrar datos.
 */
import { and, count, desc, eq, gte, ilike, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { HelgaSyncStatus } from '@courier/shared';
import type { ListShipmentsQuery, State } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { settlementColumn } from '../payments/settlement';
import { districtRoutes } from '../routes/district-route.schema';
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
  createdAt: shipments.createdAt,
  updatedAt: shipments.updatedAt,
  clientId: clients.id,
  clientCode: clients.code,
  clientName: users.name,
  routeNumber: districtRoutes.routeNumber,
};

/** Consulta base con los joins de lectura; se le encadenan los filtros. */
function baseQuery() {
  return db
    .select(columns)
    .from(shipments)
    .innerJoin(clients, eq(shipments.clientId, clients.id))
    .innerJoin(users, eq(clients.userId, users.id))
    .leftJoin(districtRoutes, eq(clients.districtCode, districtRoutes.districtCode));
}

/**
 * Traduce los filtros del dashboard a condiciones SQL. `ownerClientId` lo pone
 * el servicio cuando la sesion es de un cliente: es la barrera de "lo propio" y
 * NO puede llegar desde la query del usuario.
 */
function buildConditions(query: ListShipmentsQuery, ownerClientId?: string): SQL[] {
  const conds: SQL[] = [];

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
  /** Lista filtrada, del mas reciente al mas antiguo. */
  async list(query: ListShipmentsQuery, ownerClientId?: string) {
    const conds = buildConditions(query, ownerClientId);
    const q = baseQuery().orderBy(desc(shipments.createdAt));
    return conds.length > 0 ? q.where(and(...conds)) : q;
  },

  /** Un tramite por id, con cliente y ruta. */
  async findById(id: string) {
    const [row] = await baseQuery().where(eq(shipments.id, id)).limit(1);
    return row ?? null;
  },

  /**
   * Tramite ACTIVO (no entregado) con ese tracking, si existe. Refleja el mismo
   * criterio que el indice unico parcial: da un error claro antes de chocar con
   * la restriccion de la BD.
   */
  async findActiveByTracking(tracking: string) {
    const [row] = await db
      .select({ id: shipments.id, code: shipments.code })
      .from(shipments)
      .where(and(eq(shipments.tracking, tracking), sql`${shipments.state} <> 'entregado'`))
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
   * Se apoya en `shipments_client_idx`.
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
        and(sql`upper(${shipments.hawb}) = upper(${hawb})`, sql`${shipments.state} <> 'entregado'`),
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
   */
  async insert(values: typeof shipments.$inferInsert) {
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(shipments).values(values).returning({ id: shipments.id });
      if (!row) throw new Error('No se pudo crear el trámite.');
      await tx.insert(shipmentEvents).values({
        shipmentId: row.id,
        state: values.state,
        createdBy: values.createdBy ?? null,
      });
      return row.id;
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
