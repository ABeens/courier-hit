/**
 * Consultas de los reportes. Solo lectura: este modulo no es dueño de ninguna
 * tabla, cruza las de tramites, clientes, eventos y pagos.
 *
 * Los filtros son los mismos del dashboard (rango de fechas, tipo, cliente) y se
 * arman una sola vez en `conditions`: un reporte que filtrara distinto que la
 * pantalla que lo origina seria un reporte que nadie puede cuadrar.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { State } from '@courier/shared';
import type { ProformaQuery, ReportQuery } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { districtRoutes } from '../routes/district-route.schema';
import { payments } from '../payments/payments.schema';
import { shipmentCosts } from '../costs/shipment-cost.schema';
import { shipmentEvents, shipments } from '../shipments/shipments.schema';

/**
 * Nombre de quien movio el estado, como SUBCONSULTA en vez de un cuarto JOIN.
 *
 * No es una preferencia de estilo: el seguimiento de joins de Drizzle deja de
 * inferir la fila (la colapsa a `never`) a partir del cuarto join en una misma
 * consulta, y el reporte transaccional ya gasta tres en tramite -> casillero ->
 * titular. La subconsulta devuelve exactamente el mismo dato sin gastar el
 * cuarto. Null = lo movio el sistema, no una persona.
 */
const moverName = sql<string | null>`(
  select ${users.name} from ${users} where ${users.id} = ${shipmentEvents.createdBy}
)`;

/**
 * Filtros comunes a todos los reportes, sobre la fecha de ingreso del tramite.
 * Toma `ProformaQuery` (los campos de alcance) y no `ReportQuery` completo: el
 * `kind` no acota nada aqui, y pedirlo obligaria a inventarle uno a la descarga
 * de proformas, que no es un reporte.
 */
function conditions(query: ProformaQuery): SQL[] {
  const conds: SQL[] = [];
  if (query.clientId) conds.push(eq(shipments.clientId, query.clientId));
  if (query.shipmentType) conds.push(inArray(shipments.shipmentType, query.shipmentType));
  // Inicio inclusive, fin exclusivo: la web manda el arranque del dia siguiente,
  // asi el ultimo dia del rango entra completo.
  if (query.from) conds.push(gte(shipments.createdAt, new Date(query.from)));
  if (query.to) conds.push(lt(shipments.createdAt, new Date(query.to)));
  return conds;
}

export const reportsRepo = {
  /** Tramites con cliente y ruta: alimenta los reportes operativos. */
  async shipments(query: ReportQuery) {
    const conds = conditions(query);
    const base = db
      .select({
        code: shipments.code,
        shipmentType: shipments.shipmentType,
        state: shipments.state,
        tracking: shipments.tracking,
        description: shipments.description,
        store: shipments.store,
        carrier: shipments.carrier,
        hawb: shipments.hawb,
        weightKg: shipments.weightKg,
        warehouse: shipments.warehouse,
        dua: shipments.dua,
        invoiceTotalUsd: shipments.invoiceTotalUsd,
        invoiceTotalCrc: shipments.invoiceTotalCrc,
        createdAt: shipments.createdAt,
        clientCode: clients.code,
        clientName: users.name,
        routeNumber: districtRoutes.routeNumber,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .leftJoin(districtRoutes, eq(clients.districtCode, districtRoutes.districtCode))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(shipments.createdAt));

    return base;
  },

  /** Historial de cambios de estado: alimenta el reporte transaccional. */
  async stateMovements(query: ReportQuery) {
    const conds = conditions(query);
    const base = db
      .select({
        code: shipments.code,
        shipmentType: shipments.shipmentType,
        tracking: shipments.tracking,
        state: shipmentEvents.state,
        note: shipmentEvents.note,
        createdAt: shipmentEvents.createdAt,
        createdByName: moverName,
        clientName: users.name,
      })
      .from(shipmentEvents)
      .innerJoin(shipments, eq(shipmentEvents.shipmentId, shipments.id))
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(shipmentEvents.createdAt));

    return base;
  },

  /**
   * Tramites CON FACTURA aprobada y sus pagos: alimenta el estado de cuenta.
   *
   * Los pagos vienen como lista por tramite (no sumados en SQL) para que el
   * total lo calcule `settledAmount` de @courier/shared, que convierte cada abono
   * con SU propia tasa. Una suma en SQL tendria que asumir una tasa unica y
   * daria un numero distinto al que ve el cliente en su pantalla de pago.
   */
  async billedShipments(query: ReportQuery) {
    const conds = conditions(query);
    const base = db
      .select({
        code: shipments.code,
        state: shipments.state,
        description: shipments.description,
        invoiceTotalCrc: shipments.invoiceTotalCrc,
        createdAt: shipments.createdAt,
        clientCode: clients.code,
        clientName: users.name,
        id: shipments.id,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(asc(clients.code), desc(shipments.createdAt));

    const rows = await base;
    if (rows.length === 0) return [];

    const paid = await db
      .select({
        shipmentId: payments.shipmentId,
        amount: payments.amount,
        currency: payments.currency,
        exchangeRate: payments.exchangeRate,
        status: payments.status,
      })
      .from(payments)
      .where(
        inArray(
          payments.shipmentId,
          rows.map((r) => r.id),
        ),
      );

    const byShipment = new Map<string, typeof paid>();
    for (const p of paid) {
      const list = byShipment.get(p.shipmentId) ?? [];
      list.push(p);
      byShipment.set(p.shipmentId, list);
    }

    return rows.map((row) => ({ ...row, payments: byShipment.get(row.id) ?? [] }));
  },

  /**
   * Tramites con TODO lo que necesitan los reportes por servicio: el tramite, su
   * cliente, sus pagos, sus lineas de costo y las dos fechas que no son columnas
   * sino hitos de su historial.
   *
   * Cuatro consultas y no un JOIN gigante, a proposito: pagos y costos son
   * relaciones 1:N y unirlas en la misma consulta multiplicaria las filas (un
   * tramite con 3 costos y 2 pagos saldria 6 veces), obligando a desduplicar en
   * memoria justo lo que se queria evitar. Cada una trae lo suyo y se cruzan por
   * id, que es una operacion de mapa, no de SQL.
   */
  async serviceReportRows(query: ReportQuery) {
    const conds = conditions(query);

    const rows = await db
      .select({
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
        warehouse: shipments.warehouse,
        dua: shipments.dua,
        billingNotes: shipments.billingNotes,
        electronicInvoiceNumber: shipments.electronicInvoiceNumber,
        invoiceTotalUsd: shipments.invoiceTotalUsd,
        invoiceTotalCrc: shipments.invoiceTotalCrc,
        freightRateUsdPerLb: shipments.freightRateUsdPerLb,
        costsApprovedAt: shipments.costsApprovedAt,
        createdAt: shipments.createdAt,
        clientCode: clients.code,
        clientName: users.name,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(shipments.createdAt));

    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const [paid, costs, milestones] = await Promise.all([
      db
        .select({
          shipmentId: payments.shipmentId,
          amount: payments.amount,
          currency: payments.currency,
          exchangeRate: payments.exchangeRate,
          status: payments.status,
          bankAccount: payments.bankAccount,
          receiptNumber: payments.receiptNumber,
          receiptFileKey: payments.receiptFileKey,
          confirmedAt: payments.confirmedAt,
        })
        .from(payments)
        .where(inArray(payments.shipmentId, ids)),

      db
        .select({
          shipmentId: shipmentCosts.shipmentId,
          amount: shipmentCosts.amount,
          currency: shipmentCosts.currency,
          exchangeRate: shipmentCosts.exchangeRate,
          category: shipmentCosts.category,
        })
        .from(shipmentCosts)
        .where(inArray(shipmentCosts.shipmentId, ids)),

      /**
       * Fechas de arribo a Miami y de entrega. NO son columnas del tramite: son
       * el momento en que entro a un estado, y eso ya vive en el historial
       * append-only. Agregar dos columnas duplicaria un dato que el historial
       * responde igual de bien y que ademas puede corregirse.
       *
       * Se toma el PRIMER evento de cada estado (`min`): un paquete puede volver
       * a bodega y salir de nuevo, y la fecha de entrega que interesa es la de la
       * entrega, no la del ultimo reintento.
       */
      db
        .select({
          shipmentId: shipmentEvents.shipmentId,
          state: shipmentEvents.state,
          at: sql<Date>`min(${shipmentEvents.createdAt})`,
        })
        .from(shipmentEvents)
        .where(
          and(
            inArray(shipmentEvents.shipmentId, ids),
            inArray(shipmentEvents.state, [State.RecibidoBodegaMiami, State.Entregado]),
          ),
        )
        .groupBy(shipmentEvents.shipmentId, shipmentEvents.state),
    ]);

    const paymentsBy = groupBy(paid, (p) => p.shipmentId);
    const costsBy = groupBy(costs, (c) => c.shipmentId);
    const milestoneBy = new Map<string, { miamiArrivalAt: Date | null; deliveredAt: Date | null }>();
    for (const row of milestones) {
      const entry = milestoneBy.get(row.shipmentId) ?? { miamiArrivalAt: null, deliveredAt: null };
      if (row.state === State.RecibidoBodegaMiami) entry.miamiArrivalAt = row.at;
      else entry.deliveredAt = row.at;
      milestoneBy.set(row.shipmentId, entry);
    }

    return rows.map((row) => ({
      ...row,
      payments: paymentsBy.get(row.id) ?? [],
      costs: costsBy.get(row.id) ?? [],
      miamiArrivalAt: milestoneBy.get(row.id)?.miamiArrivalAt ?? null,
      deliveredAt: milestoneBy.get(row.id)?.deliveredAt ?? null,
    }));
  },

  /**
   * Un tramite con lo necesario para su proforma. Reusa `serviceReportRows` en
   * vez de tener su consulta propia: la proforma tiene que decir exactamente lo
   * mismo que el reporte sobre el mismo tramite, y dos consultas paralelas es
   * como se empiezan a separar.
   */
  async proformaRow(shipmentId: string) {
    const [row] = await db
      .select({
        id: shipments.id,
        code: shipments.code,
        shipmentType: shipments.shipmentType,
        tracking: shipments.tracking,
        description: shipments.description,
        hawb: shipments.hawb,
        weightKg: shipments.weightKg,
        electronicInvoiceNumber: shipments.electronicInvoiceNumber,
        invoiceTotalUsd: shipments.invoiceTotalUsd,
        costsApprovedAt: shipments.costsApprovedAt,
        clientName: users.name,
        clientEmail: users.email,
        clientPhone: users.phone,
        idNumber: clients.idNumber,
        provinceCode: clients.provinceCode,
        cantonCode: clients.cantonCode,
        districtCode: clients.districtCode,
        addressLine: clients.addressLine,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(eq(shipments.id, shipmentId))
      .limit(1);
    if (!row) return null;

    const [lines, delivered] = await Promise.all([
      db
        .select({
          label: shipmentCosts.label,
          category: shipmentCosts.category,
          electronicInvoiceCode: shipmentCosts.electronicInvoiceCode,
          amount: shipmentCosts.amount,
          currency: shipmentCosts.currency,
          exchangeRate: shipmentCosts.exchangeRate,
        })
        .from(shipmentCosts)
        .where(eq(shipmentCosts.shipmentId, shipmentId))
        .orderBy(shipmentCosts.createdAt),

      db
        .select({ at: sql<Date>`min(${shipmentEvents.createdAt})` })
        .from(shipmentEvents)
        .where(
          and(
            eq(shipmentEvents.shipmentId, shipmentId),
            eq(shipmentEvents.state, State.Entregado),
          ),
        ),
    ]);

    return { ...row, lines, deliveredAt: delivered[0]?.at ?? null };
  },

  /** Ids de los tramites ya facturados del filtro: los que tienen proforma lista. */
  async billedShipmentIds(query: ProformaQuery) {
    const conds = [...conditions(query), isNotNull(shipments.costsApprovedAt)];
    const rows = await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(and(...conds))
      .orderBy(desc(shipments.createdAt));
    return rows.map((r) => r.id);
  },
};

/** Agrupa filas por una clave. Evita repetir el mismo bucle tres veces arriba. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}
