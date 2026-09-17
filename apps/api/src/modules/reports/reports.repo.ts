/**
 * Consultas de los reportes. Casi todo es lectura: cruza las tablas de tramites,
 * clientes, eventos y pagos sin ser dueño de ninguna. La UNICA excepcion es
 * `proforma_numbers`, la serie de proformas, que si es suya y si se escribe (ver
 * `issueProformaNumber`): emitir un documento numerado es un acto, no una
 * consulta, y el numero tiene que sobrevivir a la impresion que lo pidio.
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
import { ClientRateKind, State } from '@courier/shared';
import type { ProformaQuery, ReportQuery } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { cantonRoutes } from '../routes/canton-route.schema';
import { districtRoutes } from '../routes/district-route.schema';
import { cantonRouteJoin, districtRouteJoin, effectiveRouteNumber } from '../routes/effective-route';
import { payments } from '../payments/payments.schema';
import { clientRates } from '../tariffs/tariffs.schema';
import { shipmentCosts } from '../costs/shipment-cost.schema';
import { shipmentEvents, shipments } from '../shipments/shipments.schema';
import { proformaNumbers } from './reports.schema';

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
        routeNumber: effectiveRouteNumber,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .leftJoin(districtRoutes, districtRouteJoin)
      .leftJoin(cantonRoutes, cantonRouteJoin)
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
            inArray(shipmentEvents.state, [State.RecibidoBodegaMiami, State.Entregado]),
          ),
        )
        .groupBy(shipmentEvents.shipmentId, shipmentEvents.state),

      /**
       * Numeros de proforma YA EMITIDOS. La columna PROFORMA del reporte era el
       * consecutivo del tramite repetido; ahora dice el numero del documento que
       * de verdad se entrego, y queda vacia en el que nunca se imprimio. Leer y
       * no emitir es la mitad importante: un reporte de mil filas no puede gastar
       * mil numeros de la serie de facturacion (ver `proformaNumbersByShipment`).
       */
      this.proformaNumbersByShipment(ids),
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
      proformaSequence: proformaSeqs.get(row.id) ?? null,
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
        .select({ at: firstEventAt })
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

  /**
   * Ids de los tramites ya facturados del filtro: los que tienen proforma lista.
   *
   * QUEDAN FUERA LOS DE CUENTAS CONSOLIDADAS. El requisito lo pide explicito ("la
   * proforma de paquetes consolidados solo estara disponible para tarifas de
   * consolidacion y no se incluira en reportes anteriores"), y ademas es lo unico
   * consistente: esos paquetes se cobran juntos y su documento es la proforma
   * agrupada, asi que listarlos tambien aqui entregaria dos documentos por el
   * mismo dinero.
   *
   * El LEFT JOIN es deliberado: un tramite sin casillero o un casillero sin tarifa
   * no son consolidados y tienen que seguir apareciendo, y con INNER se habrian
   * caido del listado sin que nadie lo pidiera.
   */
  async billedShipmentIds(query: ProformaQuery) {
    const rows = await db
      .select({ id: shipments.id })
      .from(shipments)
      .leftJoin(clients, eq(shipments.clientId, clients.id))
      .leftJoin(clientRates, eq(clients.clientRateId, clientRates.id))
      .where(and(...billedConditions(query)))
      .orderBy(desc(shipments.createdAt));
    return rows.map((r) => r.id);
  },

  /**
   * CUANTOS tramites facturados hay en el filtro. Lo cuenta la base de datos.
   *
   * Va aparte de `billedShipmentIds` porque la pantalla pregunta "cuantas
   * proformas voy a abrir" ANTES de abrirlas, y responder eso trayendose quince
   * mil ids (o peor, armando doscientas proformas enteras) es trabajo que nadie
   * mira. Las dos comparten `billedConditions`, que es lo que impide que el
   * numero que se anuncia y el lote que se descarga hablen de conjuntos distintos.
   */
  async countBilledShipments(query: ProformaQuery): Promise<number> {
    const [row] = await db
      .select({ total: count() })
      .from(shipments)
      .leftJoin(clients, eq(shipments.clientId, clients.id))
      .leftJoin(clientRates, eq(clients.clientRateId, clientRates.id))
      .where(and(...billedConditions(query)));
    return row?.total ?? 0;
  },

  /**
   * El numero de proforma del documento que se esta emitiendo: el que ya tenia,
   * o uno nuevo de la serie si es la primera vez.
   *
   * SE ASIGNA AL EMITIR y no al aprobar los costos. La proforma se pide muchas
   * menos veces de las que se factura (hay tramites facturados que nunca se
   * imprimen), y numerar al aprobar llenaria la serie de numeros que no
   * corresponden a ningun documento entregado.
   *
   * El "leer, insertar, releer" no es un bucle de reintento disfrazado: el
   * `on conflict do nothing` cubre la carrera de dos impresiones simultaneas del
   * mismo documento, y la relectura recupera el numero que gano esa carrera. La
   * primera lectura existe para no gastar un `nextval` en el caso normal, que es
   * el de un documento que ya tiene numero: `nextval` avanza la secuencia aunque
   * el INSERT se descarte despues, y eso deja huecos en el consecutivo.
   */
  async issueProformaNumber(
    owner: { shipmentId: string } | { paymentGroupId: string },
  ): Promise<number> {
    const where =
      'shipmentId' in owner
        ? eq(proformaNumbers.shipmentId, owner.shipmentId)
        : eq(proformaNumbers.paymentGroupId, owner.paymentGroupId);

    const read = async () => {
      const [row] = await db
        .select({ sequence: proformaNumbers.sequence })
        .from(proformaNumbers)
        .where(where)
        .limit(1);
      return row?.sequence ?? null;
    };

    const existing = await read();
    if (existing !== null) return existing;

    const [created] = await db
      .insert(proformaNumbers)
      .values({ ...owner, sequence: sql`nextval('hs_proforma_number_seq')` })
      .onConflictDoNothing()
      .returning({ sequence: proformaNumbers.sequence });
    if (created) return created.sequence;

    const raced = await read();
    if (raced === null) throw new Error('No se pudo asignar el número de proforma.');
    return raced;
  },

  /**
   * Los numeros ya emitidos de un conjunto de tramites, para la columna PROFORMA
   * del reporte. NO emite ninguno: un reporte es una lectura, y listar mil
   * tramites no puede consumir mil numeros de una serie de facturacion. El que
   * todavia no tiene proforma emitida sale con la celda vacia, que es la verdad.
   */
  async proformaNumbersByShipment(shipmentIds: readonly string[]): Promise<Map<string, number>> {
    if (shipmentIds.length === 0) return new Map();
    const rows = await db
      .select({ shipmentId: proformaNumbers.shipmentId, sequence: proformaNumbers.sequence })
      .from(proformaNumbers)
      .where(inArray(proformaNumbers.shipmentId, [...shipmentIds]));

    const map = new Map<string, number>();
    for (const row of rows) if (row.shipmentId) map.set(row.shipmentId, row.sequence);
    return map;
  },
};

/**
 * Que es un tramite "con proforma lista": facturado (costos aprobados) y no
 * consolidado, dentro del filtro de alcance. Punto UNICO de esa definicion,
 * compartido por el listado y por el conteo; con la condicion escrita dos veces,
 * el numero que anuncia la pantalla y el documento que se descarga acabarian
 * hablando de conjuntos distintos.
 *
 * El LEFT JOIN de la consulta es deliberado: un tramite sin casillero o un
 * casillero sin tarifa no son consolidados y tienen que seguir apareciendo.
 */
function billedConditions(query: ProformaQuery): (SQL | undefined)[] {
  return [
    ...conditions(query),
    isNotNull(shipments.costsApprovedAt),
    or(isNull(clientRates.kind), ne(clientRates.kind, ClientRateKind.Consolidada)),
  ];
}

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
