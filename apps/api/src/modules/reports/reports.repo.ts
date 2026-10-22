/**
 * Consultas de los reportes. Todo es lectura: cruza las tablas de tramites,
 * clientes, eventos, pagos y proformas sin ser dueño de ninguna.
 *
 * Los filtros son los mismos del dashboard (rango de fechas, tipo, cliente) y se
 * arman una sola vez en `conditions`: un reporte que filtrara distinto que la
 * pantalla que lo origina seria un reporte que nadie puede cuadrar.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { ClientRateKind, ProformaStatus, State, terminalStates } from '@courier/shared';
import type { ReportQuery } from '@courier/shared';

/**
 * Los estados que cierran un tramite. Paqueteria termina en Entregado y los
 * otros dos en Tramite Finalizado, asi que la fecha de cierre se busca contra el
 * conjunto: con el literal de antes, los reportes dejaban de contar Transporte y
 * Agenciamiento sin dar ningun error.
 */
const CLOSING_STATES = [...terminalStates()];
import { db } from '../../core/db';
import { allocatedProformaCosts } from '../proformas/proforma-allocation';
import { proformasRepo } from '../proformas/proformas.repo';
import { proformaShipments, proformas } from '../proformas/proformas.schema';
import { clients, users } from '../auth/auth.schema';
import { cantonRoutes } from '../routes/canton-route.schema';
import { districtRoutes } from '../routes/district-route.schema';
import { cantonRouteJoin, districtRouteJoin, effectiveRouteNumber } from '../routes/effective-route';
import { payments } from '../payments/payments.schema';
import { clientRates } from '../tariffs/tariffs.schema';
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
 * Instante en que el tramite entro POR PRIMERA VEZ a un estado.
 *
 * El `.mapWith` no es adorno: en una expresion `sql` cruda Drizzle no sabe que
 * tipo devuelve y entrega el valor tal como lo da el driver, que para un
 * `min(timestamptz)` es una CADENA. Anotar `sql<Date>` a secas es una promesa
 * que TypeScript se cree y que en ejecucion no se cumple: quien haga
 * `.toISOString()` sobre el resultado revienta. `mapWith` aplica el mismo
 * conversor de la columna original, asi que lo que sale es un Date de verdad.
 *
 * El PRIMER evento y no el ultimo (`min`, no `max`): un paquete puede volver a
 * bodega y salir de nuevo, y la fecha de entrega que interesa es la de la
 * entrega, no la del ultimo reintento.
 */
const firstEventAt = sql<Date>`min(${shipmentEvents.createdAt})`.mapWith(shipmentEvents.createdAt);

/**
 * ULTIMA ACTUALIZACION del tramite: su ultimo cambio de estado. Sale del
 * historial y no de `updated_at`, que se mueve con cualquier edicion tecnica
 * (sincronizacion con Helga, correcciones) sin que el envio haya avanzado. Un
 * tramite sin eventos (no deberia haberlo) cae a su fecha de creacion.
 *
 * `mapWith` por la misma razon que en `firstEventAt`: sin el, el driver entrega
 * una cadena y no un Date.
 */
const lastMovedAt = sql<Date>`coalesce(
  (select max(${shipmentEvents.createdAt}) from ${shipmentEvents}
    where ${shipmentEvents.shipmentId} = ${shipments.id}),
  ${shipments.createdAt}
)`.mapWith(shipments.createdAt);

/**
 * Filtros comunes a todos los reportes de tramites. Toma solo los campos de
 * alcance: el `kind` no acota nada aqui.
 *
 * El rango se aplica sobre `dateColumn`: por defecto la fecha de ingreso, y en
 * los operativos la ultima actualizacion, que es la fecha que muestran. Un
 * filtro sobre una fecha distinta de la que se ve dejaria en el reporte filas
 * que a simple vista no caen en el rango.
 */
function conditions(
  query: Pick<ReportQuery, 'clientId' | 'shipmentType' | 'from' | 'to'>,
  dateColumn: SQL | typeof shipments.createdAt = shipments.createdAt,
): SQL[] {
  const conds: SQL[] = [];
  if (query.clientId) conds.push(eq(shipments.clientId, query.clientId));
  if (query.shipmentType) conds.push(inArray(shipments.shipmentType, query.shipmentType));
  // Inicio inclusive, fin exclusivo: la web manda el arranque del dia siguiente,
  // asi el ultimo dia del rango entra completo. Viajan como ISO con cast
  // explicito: sobre una expresion `sql` Drizzle no sabe serializar un Date.
  if (query.from) conds.push(sql`${dateColumn} >= ${new Date(query.from).toISOString()}::timestamptz`);
  if (query.to) conds.push(sql`${dateColumn} < ${new Date(query.to).toISOString()}::timestamptz`);
  return conds;
}

export const reportsRepo = {
  /**
   * Tramites con cliente y ruta: alimenta los reportes operativos. El rango y el
   * orden van por la ultima actualizacion, que es la fecha que muestran.
   */
  async shipments(query: ReportQuery) {
    const conds = conditions(query, lastMovedAt);
    const base = db
      .select({
        code: shipments.code,
        shipmentType: shipments.shipmentType,
        state: shipments.state,
        tracking: shipments.tracking,
        description: shipments.description,
        cnee: shipments.cnee,
        store: shipments.store,
        carrier: shipments.carrier,
        hawb: shipments.hawb,
        weightKg: shipments.weightKg,
        warehouse: shipments.warehouse,
        dua: shipments.dua,
        invoiceTotalUsd: shipments.invoiceTotalUsd,
        invoiceTotalCrc: shipments.invoiceTotalCrc,
        lastMovedAt,
        clientCode: clients.code,
        /** Sub-casillero de Helga: la direccion con la que el cliente compra en Miami. */
        miamiAccount: clients.helgaSubLocker,
        clientName: users.name,
        routeNumber: effectiveRouteNumber,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .leftJoin(districtRoutes, districtRouteJoin)
      .leftJoin(cantonRoutes, cantonRouteJoin)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(lastMovedAt));

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
        hawb: shipments.hawb,
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
   * PROFORMAS EMITIDAS (aprobadas o pagadas) con sus tramites y sus pagos:
   * alimenta el estado de cuenta. Los borradores no entran: no son un documento
   * que se le cobre a nadie.
   *
   * El rango va sobre la fecha de APROBACION de la proforma, no sobre la de
   * ingreso de los tramites: el reporte responde cuanto se facturo y cuanto se
   * debe en el periodo, y eso lo fija la emision.
   *
   * Los pagos vienen como lista (no sumados en SQL) para que el total lo calcule
   * `settledAmount` de @courier/shared, que convierte cada abono con SU propia
   * tasa. Una suma en SQL tendria que asumir una tasa unica y daria un numero
   * distinto al que ve el cliente en su pantalla de pago.
   */
  async billedProformas(query: ReportQuery) {
    const conds: SQL[] = [inArray(proformas.status, [ProformaStatus.Aprobada, ProformaStatus.Pagada])];
    if (query.clientId) conds.push(eq(proformas.clientId, query.clientId));
    if (query.from) conds.push(gte(proformas.approvedAt, new Date(query.from)));
    if (query.to) conds.push(lt(proformas.approvedAt, new Date(query.to)));
    if (query.shipmentType) {
      // Una proforma puede juntar tipos (aereo con maritimo): entra si contiene
      // al menos un tramite del tipo pedido.
      conds.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(proformaShipments)
            .innerJoin(shipments, eq(proformaShipments.shipmentId, shipments.id))
            .where(
              and(
                eq(proformaShipments.proformaId, proformas.id),
                inArray(shipments.shipmentType, query.shipmentType),
              ),
            ),
        ),
      );
    }

    const rows = await db
      .select({
        id: proformas.id,
        number: proformas.number,
        currency: proformas.currency,
        exchangeRate: proformas.exchangeRate,
        totalUsd: proformas.totalUsd,
        totalCrc: proformas.totalCrc,
        electronicInvoiceNumber: proformas.electronicInvoiceNumber,
        approvedAt: proformas.approvedAt,
        paidAt: proformas.paidAt,
        clientCode: clients.code,
        miamiAccount: clients.helgaSubLocker,
        clientName: users.name,
      })
      .from(proformas)
      .innerJoin(clients, eq(proformas.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(and(...conds))
      .orderBy(asc(clients.code), asc(proformas.number));

    if (rows.length === 0) return [];

    const members = await db
      .select({
        proformaId: proformaShipments.proformaId,
        shipmentId: proformaShipments.shipmentId,
        weightKg: shipments.weightKg,
      })
      .from(proformaShipments)
      .innerJoin(shipments, eq(proformaShipments.shipmentId, shipments.id))
      .where(
        inArray(
          proformaShipments.proformaId,
          rows.map((r) => r.id),
        ),
      );

    const paid =
      members.length === 0
        ? []
        : await db
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
                members.map((m) => m.shipmentId),
              ),
            );

    const membersBy = groupBy(members, (m) => m.proformaId);
    const paymentsBy = groupBy(paid, (p) => p.shipmentId);

    return rows.map((row) => {
      const own = membersBy.get(row.id) ?? [];
      return {
        ...row,
        shipments: own,
        payments: own.flatMap((m) => paymentsBy.get(m.shipmentId) ?? []),
      };
    });
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
        cnee: shipments.cnee,
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
        freightRateUsdPerKg: shipments.freightRateUsdPerKg,
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

    const [paid, costs, milestones, proformaSeqs] = await Promise.all([
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
          realAmount: shipmentCosts.realAmount,
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
       * responde igual de bien y que ademas puede corregirse. Ver `firstEventAt`.
       */
      db
        .select({
          shipmentId: shipmentEvents.shipmentId,
          state: shipmentEvents.state,
          at: firstEventAt,
        })
        .from(shipmentEvents)
        .where(
          and(
            inArray(shipmentEvents.shipmentId, ids),
            inArray(shipmentEvents.state, [State.RecibidoBodegaMiami, ...CLOSING_STATES]),
          ),
        )
        .groupBy(shipmentEvents.shipmentId, shipmentEvents.state),

      /**
       * Numero, factura electronica y fecha de aprobacion de la proforma APROBADA
       * de cada tramite. Un borrador no es un documento emitido: su tramite sale
       * con la celda vacia.
       */
      proformasRepo.numbersByShipment(ids),
    ]);

    const paymentsBy = groupBy(paid, (p) => p.shipmentId);
    /**
     * Las lineas del tramite MAS su parte de los servicios de la proforma: la
     * factura congelada ya los incluye, y el desglose por categoria tiene que
     * cuadrar con ella (ver `allocatedProformaCosts`).
     */
    const costsBy = groupBy([...costs, ...(await allocatedProformaCosts(ids))], (c) => c.shipmentId);
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
      proformaSequence: proformaSeqs.get(row.id)?.number ?? null,
      proformaElectronicInvoiceNumber: proformaSeqs.get(row.id)?.electronicInvoiceNumber ?? null,
      proformaApprovedAt: proformaSeqs.get(row.id)?.approvedAt ?? null,
      /**
       * Moneda de cobro de esa proforma, para el ESTATUS COBRO. Sin numero no
       * hay factura emitida, y la moneda del flujo da la misma respuesta (nada
       * que cobrar todavia).
       */
      proformaCurrency: proformaSeqs.get(row.id)?.currency ?? null,
    }));
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
