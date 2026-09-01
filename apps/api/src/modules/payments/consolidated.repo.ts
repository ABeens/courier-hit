/**
 * Acceso a datos del COBRO AGRUPADO (cuentas consolidadas).
 *
 * Es dueño de `payment_groups` y, ademas, hace UNA lectura que cruza tramites y
 * abonos: la de los paquetes que entran en el grupo. Va aqui y no en
 * `shipments.repo` a proposito: "que paquetes se cobran juntos" es una pregunta
 * de facturacion, no del inventario de tramites, y la respuesta tiene que salir
 * de un solo sitio porque la usan tres caminos que no se pueden contradecir (la
 * cotizacion que ve el cliente, el cobro que la crea y la guarda que rechaza el
 * pago suelto).
 *
 * Como en el resto del modulo, las sumas de dinero NO se hacen en SQL: los abonos
 * viajan crudos y los totaliza @courier/shared, que es donde vive la conversion
 * con la tasa de cada abono (M5) y el redondeo por moneda (M4).
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { PaymentStatus, State } from '@courier/shared';
import type { Currency } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { shipments } from '../shipments/shipments.schema';
import { clientRates } from '../tariffs/tariffs.schema';
import { paymentGroups, payments } from './payments.schema';
import { settlementColumn } from './settlement';

/**
 * Nombre de quien registro el cobro, como SUBCONSULTA en vez de un cuarto JOIN.
 *
 * No es estilo: el seguimiento de joins de Drizzle deja de inferir la fila (la
 * colapsa a `never`) a partir del cuarto join en una misma consulta, y `findGroup`
 * ya gasta tres en grupo -> casillero -> titular. Mismo truco y mismo motivo que
 * en `reports.repo`. Null = lo registro el propio cliente o el usuario ya no existe.
 */
const creatorName = sql<string | null>`(
  select ${users.name} from ${users} where ${users.id} = ${paymentGroups.createdBy}
)`;

/**
 * Paquete listo para entrar en un cobro agrupado. Trae sus abonos crudos para que
 * el servicio calcule el saldo con las funciones de dinero compartidas.
 */
export interface ConsolidatedCandidate {
  id: string;
  code: string;
  tracking: string;
  description: string;
  weightKg: number | null;
  invoiceTotalUsd: number | null;
  invoiceTotalCrc: number | null;
  settlement: { amount: number; currency: Currency; exchangeRate: number; status: PaymentStatus }[];
}

export const consolidatedRepo = {
  /**
   * Los paquetes que se cobran juntos: TODOS los del casillero que estan listos
   * para facturar. Punto UNICO de esa definicion.
   *
   * "Listo para facturar" son las tres condiciones que ya usa el pago suelto,
   * juntas: factura congelada (las dos monedas), estado "En bodega - Pendiente
   * pago" —el unico en que `paymentsService.start` deja cobrar— y no archivado.
   * Aflojar cualquiera de las tres metería en el grupo un paquete que la guarda
   * del pago individual habría rechazado.
   *
   * Del mas antiguo al mas nuevo: el documento se lee mejor en el orden en que
   * llegaron los paquetes, y ese orden no depende de cuando se pidio.
   */
  async billableShipments(clientId: string): Promise<ConsolidatedCandidate[]> {
    return db
      .select({
        id: shipments.id,
        code: shipments.code,
        tracking: shipments.tracking,
        description: shipments.description,
        weightKg: shipments.weightKg,
        invoiceTotalUsd: shipments.invoiceTotalUsd,
        invoiceTotalCrc: shipments.invoiceTotalCrc,
        settlement: settlementColumn,
      })
      .from(shipments)
      .where(
        and(
          eq(shipments.clientId, clientId),
          eq(shipments.state, State.EnBodegaPendientePago),
          isNotNull(shipments.invoiceTotalCrc),
          isNotNull(shipments.invoiceTotalUsd),
          isNull(shipments.discardedAt),
        ),
      )
      .orderBy(shipments.createdAt);
  },

  /** El casillero con su tarifa, para saber si la cuenta es consolidada. */
  async clientWithRate(clientId: string) {
    const [row] = await db
      .select({
        clientId: clients.id,
        clientCode: clients.code,
        clientName: users.name,
        rateId: clientRates.id,
        rateName: clientRates.name,
        rateKind: clientRates.kind,
        allowsCard: clientRates.allowsCard,
        allowsBankDeposit: clientRates.allowsBankDeposit,
      })
      .from(clients)
      .innerJoin(users, eq(clients.userId, users.id))
      .leftJoin(clientRates, eq(clients.clientRateId, clientRates.id))
      .where(eq(clients.id, clientId))
      .limit(1);
    return row ?? null;
  },

  // -------------------------------------------------------------------------
  // payment_groups
  // -------------------------------------------------------------------------

  async findGroup(id: string) {
    const [row] = await db
      .select({
        id: paymentGroups.id,
        clientId: paymentGroups.clientId,
        clientCode: clients.code,
        clientName: users.name,
        clientRateId: paymentGroups.clientRateId,
        rateName: clientRates.name,
        method: paymentGroups.method,
        amount: paymentGroups.amount,
        currency: paymentGroups.currency,
        exchangeRate: paymentGroups.exchangeRate,
        gatewayReference: paymentGroups.gatewayReference,
        createdAt: paymentGroups.createdAt,
        createdByName: creatorName,
      })
      .from(paymentGroups)
      .innerJoin(clients, eq(paymentGroups.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .leftJoin(clientRates, eq(paymentGroups.clientRateId, clientRates.id))
      .where(eq(paymentGroups.id, id))
      .limit(1);
    return row ?? null;
  },

  /**
   * Grupo por la referencia de la pasarela. Es la unica llave que trae el webhook
   * cuando el cobro fue agrupado: el intento de Onvo es uno solo por el total, y
   * cuelga del grupo, no de ninguno de sus abonos.
   */
  async findGroupByGatewayReference(reference: string) {
    const [row] = await db
      .select({ id: paymentGroups.id })
      .from(paymentGroups)
      .where(eq(paymentGroups.gatewayReference, reference))
      .limit(1);
    return row ?? null;
  },

  async updateGroup(id: string, patch: Partial<typeof paymentGroups.$inferInsert>) {
    await db.update(paymentGroups).set(patch).where(eq(paymentGroups.id, id));
  },

  /**
   * Borra el grupo con sus abonos. Solo para deshacer un cobro que nunca llego a
   * existir (la pasarela fallo al crear el intento, o el cliente cerro el
   * formulario sin pagar), igual que `paymentsRepo.remove` en el pago suelto.
   */
  async removeGroup(id: string) {
    await db.transaction(async (tx) => {
      await tx.delete(payments).where(eq(payments.groupId, id));
      await tx.delete(paymentGroups).where(eq(paymentGroups.id, id));
    });
  },

  /** Los abonos de un grupo: uno por paquete. */
  async groupPayments(groupId: string) {
    return db
      .select({
        id: payments.id,
        shipmentId: payments.shipmentId,
        status: payments.status,
        amount: payments.amount,
        currency: payments.currency,
        exchangeRate: payments.exchangeRate,
        confirmedAt: payments.confirmedAt,
      })
      .from(payments)
      .where(eq(payments.groupId, groupId));
  },

  /**
   * Crea el grupo y sus abonos en UNA transaccion. No es un lujo: un grupo sin
   * abonos es un documento que no cobra nada, y unos abonos sin grupo son un cobro
   * agrupado que nadie puede volver a juntar.
   */
  async insertGroupWithPayments(
    group: typeof paymentGroups.$inferInsert,
    lines: (groupId: string) => (typeof payments.$inferInsert)[],
  ): Promise<string> {
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(paymentGroups).values(group).returning({ id: paymentGroups.id });
      if (!row) throw new Error('No se pudo crear el cobro agrupado.');
      await tx.insert(payments).values(lines(row.id));
      return row.id;
    });
  },

  /**
   * Cobros con tarjeta del casillero que quedaron ABIERTOS y sin usar: todos sus
   * abonos siguen en `iniciado`. Los barre `start` antes de abrir otro formulario,
   * por lo mismo que en el pago suelto (cada pestaña cerrada deja su intento vivo
   * en Onvo).
   */
  async openCardGroups(clientId: string) {
    const rows = await db
      .select({
        id: paymentGroups.id,
        gatewayReference: paymentGroups.gatewayReference,
        status: payments.status,
      })
      .from(paymentGroups)
      .innerJoin(payments, eq(payments.groupId, paymentGroups.id))
      .where(eq(paymentGroups.clientId, clientId));

    const byGroup = new Map<string, { gatewayReference: string | null; statuses: PaymentStatus[] }>();
    for (const row of rows) {
      const entry = byGroup.get(row.id) ?? { gatewayReference: row.gatewayReference, statuses: [] };
      entry.statuses.push(row.status);
      byGroup.set(row.id, entry);
    }

    return [...byGroup.entries()]
      .filter(([, g]) => g.statuses.every((s) => s === PaymentStatus.Iniciado))
      .map(([id, g]) => ({ id, gatewayReference: g.gatewayReference }));
  },

  /**
   * Grupos de cobro para el listado de proformas consolidadas, del mas reciente al
   * mas antiguo. Se dejan fuera los que solo tienen cobros INICIADOS: son
   * formularios de tarjeta abiertos, no cobros, y no hay documento que emitir.
   */
  async listGroups(filters: { clientId?: string; from?: Date; to?: Date }) {
    const conds = [];
    if (filters.clientId) conds.push(eq(paymentGroups.clientId, filters.clientId));

    const rows = await db
      .select({
        id: paymentGroups.id,
        clientId: paymentGroups.clientId,
        clientCode: clients.code,
        clientName: users.name,
        createdAt: paymentGroups.createdAt,
        amount: paymentGroups.amount,
        currency: paymentGroups.currency,
        exchangeRate: paymentGroups.exchangeRate,
      })
      .from(paymentGroups)
      .innerJoin(clients, eq(paymentGroups.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(paymentGroups.createdAt));

    // El rango se filtra aqui y no en SQL para usar la MISMA convencion que los
    // reportes (inicio inclusive, fin exclusivo) sin repetir la expresion.
    return rows.filter(
      (r) =>
        (!filters.from || r.createdAt >= filters.from) && (!filters.to || r.createdAt < filters.to),
    );
  },

  /**
   * Situacion y tramites de varios grupos de una vez (listado de proformas).
   *
   * Trae ademas el TIPO de cada tramite: es lo unico que permite al listado de
   * proformas consolidadas respetar el filtro de tramite de la pantalla. El grupo
   * de cobro no tiene tipo propio (lo tienen sus paquetes), asi que la pregunta
   * "¿este cobro es de paqueteria?" solo se puede responder mirando aqui.
   *
   * El join es INNER y no LEFT a proposito: `payments.shipment_id` es NOT NULL con
   * borrado en cascada, asi que un abono sin tramite no existe.
   */
  async paymentsForGroups(groupIds: string[]) {
    if (groupIds.length === 0) return [];
    return db
      .select({
        groupId: payments.groupId,
        shipmentId: payments.shipmentId,
        status: payments.status,
        shipmentType: shipments.shipmentType,
      })
      .from(payments)
      .innerJoin(shipments, eq(payments.shipmentId, shipments.id))
      .where(inArray(payments.groupId, groupIds));
  },
};
