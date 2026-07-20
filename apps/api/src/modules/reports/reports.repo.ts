/**
 * Consultas de los reportes. Solo lectura: este modulo no es dueño de ninguna
 * tabla, cruza las de tramites, clientes, eventos y pagos.
 *
 * Los filtros son los mismos del dashboard (rango de fechas, tipo, cliente) y se
 * arman una sola vez en `conditions`: un reporte que filtrara distinto que la
 * pantalla que lo origina seria un reporte que nadie puede cuadrar.
 */
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { ReportQuery } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { districtRoutes } from '../routes/district-route.schema';
import { payments } from '../payments/payments.schema';
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

/** Filtros comunes a todos los reportes, sobre la fecha de ingreso del tramite. */
function conditions(query: ReportQuery): SQL[] {
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
};
