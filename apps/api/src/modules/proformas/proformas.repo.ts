/**
 * Acceso a datos de las proformas.
 *
 * Aqui no se decide ninguna regla del negocio (eso es `@courier/shared` y los
 * servicios del modulo); lo que si vive aqui son las dos garantias que solo la
 * base puede dar bajo concurrencia:
 *
 *   - UN BORRADOR QUE ACUMULA por cliente, flujo y moneda: si dos recepciones del
 *     mismo cliente intentan abrirlo a la vez, el indice unico parcial hace que
 *     una gane y la otra lo relea (`openAccumulatingDraft`).
 *   - NUMERO SIN HUECOS: el contador se lee y se avanza con bloqueo de fila en la
 *     misma transaccion que aprueba (`takeNumbers`).
 */
import { and, asc, count, desc, eq, ilike, inArray, max, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { ProformaStatus, toSlice } from '@courier/shared';
import type { Currency, Flow, ListProformasQuery } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { shipmentCosts } from '../costs/shipment-cost.schema';
import { settlementColumn } from '../payments/settlement';
import { shipments } from '../shipments/shipments.schema';
import {
  PROFORMA_COUNTER_ID,
  proformaCosts,
  proformaCounter,
  proformaShipments,
  proformas,
} from './proformas.schema';

/** Columnas de una linea de costo de un tramite. */
const shipmentLineColumns = {
  id: shipmentCosts.id,
  shipmentId: shipmentCosts.shipmentId,
  costServiceId: shipmentCosts.costServiceId,
  label: shipmentCosts.label,
  category: shipmentCosts.category,
  electronicInvoiceCode: shipmentCosts.electronicInvoiceCode,
  source: shipmentCosts.source,
  percentage: shipmentCosts.percentage,
  amount: shipmentCosts.amount,
  currency: shipmentCosts.currency,
  exchangeRate: shipmentCosts.exchangeRate,
  createdAt: shipmentCosts.createdAt,
  /** Cobro que produjo la linea: solo la comision de la tarjeta lo lleva. */
  paymentId: shipmentCosts.paymentId,
};

/** Columnas de un servicio adicional de la proforma (misma forma que las del tramite). */
const proformaLineColumns = {
  id: proformaCosts.id,
  proformaId: proformaCosts.proformaId,
  costServiceId: proformaCosts.costServiceId,
  label: proformaCosts.label,
  category: proformaCosts.category,
  electronicInvoiceCode: proformaCosts.electronicInvoiceCode,
  source: proformaCosts.source,
  percentage: proformaCosts.percentage,
  amount: proformaCosts.amount,
  currency: proformaCosts.currency,
  exchangeRate: proformaCosts.exchangeRate,
  createdAt: proformaCosts.createdAt,
};

/** Cabecera con el cliente: la forma comun del listado y del detalle. */
const headerColumns = {
  proforma: proformas,
  clientCode: clients.code,
  clientName: users.name,
  shipmentCount: sql<number>`(select count(*)::int from ${proformaShipments} where ${proformaShipments.proformaId} = ${proformas.id})`,
  /**
   * Cuantos de sus tramites estan entregados y cuantos finalizados: con eso se
   * deriva el estado de entrega (`proformaDeliveryStatus`) sin traer los tramites.
   */
  deliveredCount: sql<number>`(select count(*)::int from proforma_shipments ps join shipments s on s.id = ps.shipment_id where ps.proforma_id = ${proformas.id} and s.state = 'entregado')`,
  finishedCount: sql<number>`(select count(*)::int from proforma_shipments ps join shipments s on s.id = ps.shipment_id where ps.proforma_id = ${proformas.id} and s.state = 'tramite_finalizado')`,
  /** Paquetes en bodega esperando salir a ruta (lo que "Enviar a ruta" mueve). */
  readyForRouteCount: sql<number>`(select count(*)::int from proforma_shipments ps join shipments s on s.id = ps.shipment_id where ps.proforma_id = ${proformas.id} and s.state = 'en_bodega_pendiente_pago')`,
};

/** Filtros del listado traducidos a SQL. */
function listConditions(query: ListProformasQuery): SQL[] {
  const conds: SQL[] = [];
  if (query.status) conds.push(eq(proformas.status, query.status));
  if (query.flow) conds.push(eq(proformas.flow, query.flow));
  if (query.clientId) conds.push(eq(proformas.clientId, query.clientId));
  if (query.q) {
    const like = `%${query.q}%`;
    const byText = or(ilike(clients.code, like), ilike(users.name, like))!;
    // Un numero se busca EXACTO: "12" no deberia traer la 120, la 1200 y la 312.
    conds.push(/^\d+$/.test(query.q) ? or(byText, eq(proformas.number, Number(query.q)))! : byText);
  }
  return conds;
}

/** Transaccion de Drizzle, para las operaciones que se encadenan con otras. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Lo que identifica a un borrador que acumula. */
export interface DraftKey {
  clientId: string;
  flow: Flow;
  currency: Currency;
}

export const proformasRepo = {
  /**
   * Pagina del listado. Orden: lo modificado mas recientemente arriba, con
   * desempate por id (regla de `http/pagination`: sin desempate, dos filas con la
   * misma fecha se cruzan entre paginas).
   */
  async list(query: ListProformasQuery) {
    const where = and(...listConditions(query));
    const { limit, offset } = toSlice(query);
    const [rows, [totalRow]] = await Promise.all([
      db
        .select(headerColumns)
        .from(proformas)
        .innerJoin(clients, eq(proformas.clientId, clients.id))
        .innerJoin(users, eq(clients.userId, users.id))
        .where(where)
        .orderBy(desc(proformas.updatedAt), desc(proformas.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ n: count() })
        .from(proformas)
        .innerJoin(clients, eq(proformas.clientId, clients.id))
        .innerJoin(users, eq(clients.userId, users.id))
        .where(where),
    ]);
    return { rows, total: totalRow?.n ?? 0 };
  },

  /** Cabecera de UNA proforma, con el cliente y el nombre de quien la aprobo. */
  async header(id: string) {
    const approver = sql<string | null>`(select u.name from users u where u.id = ${proformas.approvedBy})`;
    const [row] = await db
      .select({ ...headerColumns, approvedByName: approver })
      .from(proformas)
      .innerJoin(clients, eq(proformas.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(eq(proformas.id, id))
      .limit(1);
    return row ?? null;
  },

  /** Datos del cliente que encabezan el documento. */
  async documentClient(clientId: string) {
    const [row] = await db
      .select({
        name: users.name,
        email: users.email,
        phone: users.phone,
        idNumber: clients.idNumber,
        provinceCode: clients.provinceCode,
        cantonCode: clients.cantonCode,
        districtCode: clients.districtCode,
        addressLine: clients.addressLine,
      })
      .from(clients)
      .innerJoin(users, eq(clients.userId, users.id))
      .where(eq(clients.id, clientId))
      .limit(1);
    return row ?? null;
  },

  /** Tramites de la proforma, en el orden en que entraron. */
  async shipmentsOf(proformaId: string) {
    return db
      .select({
        id: shipments.id,
        code: shipments.code,
        clientId: shipments.clientId,
        shipmentType: shipments.shipmentType,
        state: shipments.state,
        tracking: shipments.tracking,
        hawb: shipments.hawb,
        description: shipments.description,
        weightKg: shipments.weightKg,
        discardedAt: shipments.discardedAt,
        costsApprovedAt: shipments.costsApprovedAt,
        addedAt: proformaShipments.addedAt,
      })
      .from(proformaShipments)
      .innerJoin(shipments, eq(proformaShipments.shipmentId, shipments.id))
      .where(eq(proformaShipments.proformaId, proformaId))
      .orderBy(asc(proformaShipments.addedAt), asc(shipments.code));
  },

  /** Lineas de costo propias de los tramites de varias proformas a la vez. */
  async shipmentLinesOf(proformaIds: readonly string[]) {
    if (proformaIds.length === 0) return [];
    return db
      .select({ ...shipmentLineColumns, proformaId: proformaShipments.proformaId })
      .from(shipmentCosts)
      .innerJoin(proformaShipments, eq(shipmentCosts.shipmentId, proformaShipments.shipmentId))
      .where(inArray(proformaShipments.proformaId, [...proformaIds]))
      .orderBy(asc(shipmentCosts.createdAt));
  },

  /** Servicios adicionales de varias proformas a la vez. */
  async proformaLinesOf(proformaIds: readonly string[]) {
    if (proformaIds.length === 0) return [];
    return db
      .select(proformaLineColumns)
      .from(proformaCosts)
      .where(inArray(proformaCosts.proformaId, [...proformaIds]))
      .orderBy(asc(proformaCosts.createdAt));
  },

  /** Reemplaza el juego completo de servicios adicionales, en una transaccion. */
  async replaceProformaLines(proformaId: string, lines: (typeof proformaCosts.$inferInsert)[]) {
    await db.transaction(async (tx) => {
      await tx.delete(proformaCosts).where(eq(proformaCosts.proformaId, proformaId));
      if (lines.length > 0) await tx.insert(proformaCosts).values(lines);
      await tx.update(proformas).set({ updatedAt: new Date() }).where(eq(proformas.id, proformaId));
    });
  },

  /**
   * Fija el importe de servicios de la proforma ya guardados, dentro de `tx`. Lo
   * usa la aprobacion para congelar los porcentajes calculados sobre el subtotal
   * de ese momento.
   */
  async setProformaLineAmounts(tx: Tx, updates: readonly { id: string; amount: number }[]) {
    for (const u of updates) {
      await tx.update(proformaCosts).set({ amount: u.amount }).where(eq(proformaCosts.id, u.id));
    }
  },

  /**
   * Bloquea la proforma dentro de `tx` y la devuelve. Lo usan aprobar y corregir
   * para que dos personas no hagan lo mismo sobre la misma proforma a la vez: la
   * segunda espera, relee el estado y se encuentra con que ya no aplica.
   */
  async lockForUpdate(tx: Tx, id: string) {
    const [row] = await tx.select().from(proformas).where(eq(proformas.id, id)).for('update');
    return row ?? null;
  },

  /** Los tramites de la proforma leidos dentro de `tx` (para comparar con lo revisado). */
  async shipmentIdsIn(tx: Tx, proformaId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: proformaShipments.shipmentId })
      .from(proformaShipments)
      .where(eq(proformaShipments.proformaId, proformaId));
    return rows.map((r) => r.id);
  },

  /**
   * Congela la factura de UN tramite dentro de `tx`: los mismos seis campos que
   * `costsRepo.freezeInvoice`, pero en la transaccion de la aprobacion para que
   * la proforma y sus tramites queden congelados juntos o no quede ninguno.
   */
  async freezeShipmentInvoice(
    tx: Tx,
    shipmentId: string,
    totals: { usd: number; crc: number },
    approvedBy: string,
    freightRateUsdPerLb: number | null,
  ) {
    const now = new Date();
    await tx
      .update(shipments)
      .set({
        invoiceTotalUsd: totals.usd,
        invoiceTotalCrc: totals.crc,
        freightRateUsdPerLb,
        costsApprovedAt: now,
        costsApprovedBy: approvedBy,
        updatedAt: now,
      })
      .where(eq(shipments.id, shipmentId));
  },

  /** Descongela la factura de UN tramite dentro de `tx` (inverso exacto del anterior). */
  async releaseShipmentInvoice(tx: Tx, shipmentId: string) {
    await tx
      .update(shipments)
      .set({
        invoiceTotalUsd: null,
        invoiceTotalCrc: null,
        freightRateUsdPerLb: null,
        costsApprovedAt: null,
        costsApprovedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(shipments.id, shipmentId));
  },

  /** Marca la proforma como aprobada con todo lo que la aprobacion congela. */
  async markApproved(
    tx: Tx,
    id: string,
    frozen: {
      number: number;
      exchangeRate: number;
      totals: { usd: number; crc: number };
      approvedBy: string;
    },
  ) {
    const now = new Date();
    await tx
      .update(proformas)
      .set({
        status: ProformaStatus.Aprobada,
        // Aprobada deja de acumular: lo que llegue despues abre un borrador nuevo.
        accumulates: false,
        number: frozen.number,
        exchangeRate: frozen.exchangeRate,
        totalUsd: frozen.totals.usd,
        totalCrc: frozen.totals.crc,
        approvedAt: now,
        approvedBy: frozen.approvedBy,
        updatedAt: now,
      })
      .where(eq(proformas.id, id));
  },

  /**
   * Devuelve la proforma a borrador CONSERVANDO SU NUMERO. Limpia lo que la
   * aprobacion congelo (tasa, totales, quien y cuando) porque al reaprobar se
   * vuelve a calcular; el numero no, porque ya se le entrego al cliente.
   *
   * No vuelve a acumular: los paquetes que llegaron mientras estaba aprobada ya
   * estan en otro borrador, y el cliente no puede tener dos que acumulen.
   */
  async markDraftAgain(tx: Tx, id: string) {
    await tx
      .update(proformas)
      .set({
        status: ProformaStatus.Borrador,
        exchangeRate: null,
        totalUsd: null,
        totalCrc: null,
        approvedAt: null,
        approvedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(proformas.id, id));
  },

  async setElectronicInvoiceNumber(id: string, value: string | null) {
    await db
      .update(proformas)
      .set({ electronicInvoiceNumber: value, updatedAt: new Date() })
      .where(eq(proformas.id, id));
  },

  /** El mayor numero ya asignado, o null si no hay ninguno. */
  async lastIssuedNumber(): Promise<number | null> {
    const [row] = await db.select({ last: max(proformas.number) }).from(proformas);
    return row?.last ?? null;
  },

  /** El numero que recibira la proxima proforma aprobada. */
  async nextNumber(): Promise<number> {
    const [row] = await db
      .select({ next: proformaCounter.nextNumber })
      .from(proformaCounter)
      .where(eq(proformaCounter.id, PROFORMA_COUNTER_ID));
    // Sin fila todavia, la proxima es el default de la columna.
    return row?.next ?? 1;
  },

  /**
   * Numero y factura electronica de la proforma de cada tramite (para el
   * reporte). Solo las que tienen numero: un borrador no es un documento emitido.
   */
  async numbersByShipment(shipmentIds: readonly string[]) {
    const map = new Map<string, { number: number; electronicInvoiceNumber: string | null }>();
    if (shipmentIds.length === 0) return map;
    const rows = await db
      .select({
        shipmentId: proformaShipments.shipmentId,
        number: proformas.number,
        electronicInvoiceNumber: proformas.electronicInvoiceNumber,
      })
      .from(proformaShipments)
      .innerJoin(proformas, eq(proformaShipments.proformaId, proformas.id))
      .where(inArray(proformaShipments.shipmentId, [...shipmentIds]));
    for (const row of rows) {
      if (row.number !== null) {
        map.set(row.shipmentId, { number: row.number, electronicInvoiceNumber: row.electronicInvoiceNumber });
      }
    }
    return map;
  },

  /**
   * Proformas aprobadas o pagadas de un conjunto de tramites: las que un cobro
   * puede haber tocado. Los borradores no se cobran.
   */
  async billedProformaIdsOf(shipmentIds: readonly string[]): Promise<string[]> {
    if (shipmentIds.length === 0) return [];
    const rows = await db
      .selectDistinct({ id: proformas.id })
      .from(proformaShipments)
      .innerJoin(proformas, eq(proformaShipments.proformaId, proformas.id))
      .where(
        and(
          inArray(proformaShipments.shipmentId, [...shipmentIds]),
          inArray(proformas.status, [ProformaStatus.Aprobada, ProformaStatus.Pagada]),
        ),
      );
    return rows.map((r) => r.id);
  },

  /**
   * Los tramites de una proforma con su factura congelada y sus abonos crudos:
   * lo que hace falta para saber si la proforma ya esta pagada. Las sumas de
   * dinero las hace @courier/shared, no SQL (M4, M5).
   */
  async settlementRows(proformaId: string) {
    return db
      .select({
        id: shipments.id,
        shipmentType: shipments.shipmentType,
        invoiceTotalUsd: shipments.invoiceTotalUsd,
        invoiceTotalCrc: shipments.invoiceTotalCrc,
        settlement: settlementColumn,
      })
      .from(proformaShipments)
      .innerJoin(shipments, eq(proformaShipments.shipmentId, shipments.id))
      .where(eq(proformaShipments.proformaId, proformaId));
  },

  /**
   * Actualiza el total congelado (la comision de un cobro con tarjeta lo sube) y,
   * si corresponde, la marca de pagada. Una sola escritura para que el total y
   * el estado no puedan quedar desfasados entre si.
   */
  async applySettlement(id: string, patch: { totals: { usd: number; crc: number }; paid: boolean }) {
    const now = new Date();
    await db
      .update(proformas)
      .set({
        totalUsd: patch.totals.usd,
        totalCrc: patch.totals.crc,
        ...(patch.paid ? { status: ProformaStatus.Pagada, paidAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(proformas.id, id));
  },

  async findById(id: string) {
    const [row] = await db.select().from(proformas).where(eq(proformas.id, id)).limit(1);
    return row ?? null;
  },

  /** La proforma en la que esta el tramite, o null si no esta en ninguna. */
  async findByShipment(shipmentId: string) {
    const [row] = await db
      .select({ proforma: proformas })
      .from(proformaShipments)
      .innerJoin(proformas, eq(proformaShipments.proformaId, proformas.id))
      .where(eq(proformaShipments.shipmentId, shipmentId))
      .limit(1);
    return row?.proforma ?? null;
  },

  /**
   * El borrador que acumula del cliente, creandolo si no existe.
   *
   * Leer-insertar-releer, igual que la serie anterior, y por la misma razon: el
   * `on conflict do nothing` cubre la carrera de dos recepciones simultaneas, y
   * la relectura recupera el borrador que gano. Aqui no se gasta nada si se
   * pierde la carrera (no hay secuencia de por medio), asi que la primera
   * lectura es solo para no intentar un INSERT en el caso corriente.
   */
  async openAccumulatingDraft(key: DraftKey, createdBy: string) {
    const find = async () => {
      const [row] = await db
        .select()
        .from(proformas)
        .where(
          and(
            eq(proformas.clientId, key.clientId),
            eq(proformas.flow, key.flow),
            eq(proformas.currency, key.currency),
            eq(proformas.accumulates, true),
            eq(proformas.status, ProformaStatus.Borrador),
          ),
        )
        .limit(1);
      return row ?? null;
    };

    const existing = await find();
    if (existing) return existing;

    const [created] = await db
      .insert(proformas)
      .values({ ...key, accumulates: true, createdBy })
      .onConflictDoNothing({
        target: [proformas.clientId, proformas.flow, proformas.currency],
        where: sql`${proformas.accumulates} and ${proformas.status} = 'borrador'`,
      })
      .returning();
    if (created) return created;

    const raced = await find();
    if (!raced) throw new Error('No se pudo abrir el borrador de proforma del cliente.');
    return raced;
  },

  /** Un borrador nuevo que NO acumula (Transporte, Agenciamiento, o uno separado a mano). */
  async createDraft(key: DraftKey, createdBy: string) {
    const [created] = await db
      .insert(proformas)
      .values({ ...key, accumulates: false, createdBy })
      .returning();
    if (!created) throw new Error('No se pudo crear el borrador de proforma.');
    return created;
  },

  /**
   * Pone el tramite en la proforma. Si ya estaba en otra, lo MUEVE: la clave
   * primaria es el tramite, asi que el upsert reemplaza la proforma en vez de
   * sumar una segunda fila.
   */
  async attachShipment(proformaId: string, shipmentId: string, addedBy: string) {
    await db
      .insert(proformaShipments)
      .values({ proformaId, shipmentId, addedBy })
      .onConflictDoUpdate({
        target: proformaShipments.shipmentId,
        set: { proformaId, addedBy, addedAt: new Date() },
      });
    await this.touch(proformaId);
  },

  /** Saca el tramite de su proforma. Devuelve de cual salio, o null. */
  async detachShipment(shipmentId: string): Promise<string | null> {
    const [removed] = await db
      .delete(proformaShipments)
      .where(eq(proformaShipments.shipmentId, shipmentId))
      .returning({ proformaId: proformaShipments.proformaId });
    if (removed) await this.touch(removed.proformaId);
    return removed?.proformaId ?? null;
  },

  async countShipments(proformaId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(proformaShipments)
      .where(eq(proformaShipments.proformaId, proformaId));
    return row?.n ?? 0;
  },

  /**
   * Borra la proforma si quedo vacia y nunca se numero.
   *
   * Solo un borrador sin numero: uno con numero volvio a borrador por una
   * correccion, y su numero ya se le entrego al cliente. Borrarlo dejaria un
   * hueco en la serie que nadie podria explicar.
   */
  async deleteIfEmptyDraft(proformaId: string): Promise<boolean> {
    if ((await this.countShipments(proformaId)) > 0) return false;
    const deleted = await db
      .delete(proformas)
      .where(
        and(
          eq(proformas.id, proformaId),
          eq(proformas.status, ProformaStatus.Borrador),
          sql`${proformas.number} is null`,
        ),
      )
      .returning({ id: proformas.id });
    return deleted.length > 0;
  },

  /** Marca la proforma como modificada (orden del listado). */
  async touch(proformaId: string) {
    await db.update(proformas).set({ updatedAt: new Date() }).where(eq(proformas.id, proformaId));
  },

  /**
   * Reserva `howMany` numeros consecutivos del contador, DENTRO de `tx`.
   *
   * El `FOR UPDATE` bloquea la fila hasta que la transaccion termina: dos
   * aprobaciones simultaneas salen una detras de otra, y si la aprobacion falla
   * el avance del contador se deshace con ella. Es lo que hace la serie continua.
   *
   * Si la fila no existe todavia (base recien creada) se siembra con el valor
   * por defecto de la columna; el `on conflict` cubre que dos transacciones la
   * siembren a la vez.
   */
  async takeNumbers(tx: Tx, howMany: number): Promise<number[]> {
    if (howMany <= 0) return [];

    await tx.insert(proformaCounter).values({ id: PROFORMA_COUNTER_ID }).onConflictDoNothing();

    const [row] = await tx
      .select({ next: proformaCounter.nextNumber })
      .from(proformaCounter)
      .where(eq(proformaCounter.id, PROFORMA_COUNTER_ID))
      .for('update');
    if (!row) throw new Error('No existe el contador de proformas.');

    await tx
      .update(proformaCounter)
      .set({ nextNumber: row.next + howMany, updatedAt: new Date() })
      .where(eq(proformaCounter.id, PROFORMA_COUNTER_ID));

    return Array.from({ length: howMany }, (_, i) => row.next + i);
  },

  /**
   * Fija el numero que recibira la proxima proforma aprobada. Es la configuracion
   * del arranque de la serie; no valida contra los ya emitidos (eso lo hace el
   * servicio, que es quien sabe si hay proformas numeradas).
   */
  async setNextNumber(next: number) {
    await db
      .insert(proformaCounter)
      .values({ id: PROFORMA_COUNTER_ID, nextNumber: next })
      .onConflictDoUpdate({
        target: proformaCounter.id,
        set: { nextNumber: next, updatedAt: new Date() },
      });
  },
};
