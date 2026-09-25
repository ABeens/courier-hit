/**
 * Acceso a datos de los GRUPOS DE COBRO: un cobro (tarjeta o deposito) que cubre
 * una o varias proformas, con un abono por cada tramite de esas proformas.
 *
 * Es dueño de `payment_groups` y, ademas, hace la lectura que cruza proformas,
 * tramites y abonos: la de los tramites que entran en el cobro. Va aqui porque
 * "que se cobra junto" es una pregunta de facturacion, y la respuesta tiene que
 * salir de un solo sitio: la usan la cotizacion que ve el cliente, el cobro que
 * la crea y el registro del staff.
 *
 * Las sumas de dinero NO se hacen en SQL: los abonos viajan crudos y los
 * totaliza @courier/shared, que es donde vive la conversion con la tasa de cada
 * abono (M5) y el redondeo por moneda (M4).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { PaymentStatus, ProformaStatus } from '@courier/shared';
import type { Currency, Flow, ShipmentType } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { proformaShipments, proformas } from '../proformas/proformas.schema';
import { shipments } from '../shipments/shipments.schema';
import { clientRates } from '../tariffs/tariffs.schema';
import { paymentGroups, payments } from './payments.schema';
import { settlementColumn } from './settlement';

/**
 * Nombre de quien registro el cobro, como SUBCONSULTA en vez de un cuarto JOIN:
 * el seguimiento de joins de Drizzle colapsa la fila a `never` a partir del
 * cuarto join. Null = lo registro el propio cliente o el usuario ya no existe.
 */
const creatorName = sql<string | null>`(
  select u.name from users u where u.id = ${paymentGroups.createdBy}
)`;

/**
 * Un tramite de una proforma que se puede cobrar, con los datos de su proforma
 * y sus abonos crudos para que el servicio calcule el saldo con las funciones de
 * dinero compartidas.
 */
export interface PayableRow {
  proformaId: string;
  proformaNumber: number | null;
  proformaStatus: ProformaStatus;
  proformaCurrency: Currency;
  proformaFlow: Flow;
  approvedAt: Date | null;
  id: string;
  code: string;
  shipmentType: ShipmentType;
  invoiceTotalUsd: number | null;
  invoiceTotalCrc: number | null;
  discardedAt: Date | null;
  settlement: { amount: number; currency: Currency; exchangeRate: number; status: PaymentStatus }[];
}

const payableColumns = {
  proformaId: proformas.id,
  proformaNumber: proformas.number,
  proformaStatus: proformas.status,
  proformaCurrency: proformas.currency,
  proformaFlow: proformas.flow,
  approvedAt: proformas.approvedAt,
  id: shipments.id,
  code: shipments.code,
  shipmentType: shipments.shipmentType,
  invoiceTotalUsd: shipments.invoiceTotalUsd,
  invoiceTotalCrc: shipments.invoiceTotalCrc,
  discardedAt: shipments.discardedAt,
  settlement: settlementColumn,
};

export const paymentGroupsRepo = {
  /**
   * Los tramites de las proformas pedidas, SOLO si son de ese casillero. Una
   * proforma de otro cliente no aparece: el servicio lo lee como "no existe", que
   * es lo que tiene que ver quien pregunta por algo que no es suyo.
   */
  async payableRows(clientId: string, proformaIds: readonly string[]): Promise<PayableRow[]> {
    if (proformaIds.length === 0) return [];
    return db
      .select(payableColumns)
      .from(proformas)
      .innerJoin(proformaShipments, eq(proformaShipments.proformaId, proformas.id))
      .innerJoin(shipments, eq(proformaShipments.shipmentId, shipments.id))
      .where(and(eq(proformas.clientId, clientId), inArray(proformas.id, [...proformaIds])))
      .orderBy(asc(proformas.number), asc(shipments.code));
  },

  /** Los tramites de las proformas APROBADAS (por cobrar) del casillero. */
  async openRows(clientId: string): Promise<PayableRow[]> {
    return db
      .select(payableColumns)
      .from(proformas)
      .innerJoin(proformaShipments, eq(proformaShipments.proformaId, proformas.id))
      .innerJoin(shipments, eq(proformaShipments.shipmentId, shipments.id))
      .where(and(eq(proformas.clientId, clientId), eq(proformas.status, ProformaStatus.Aprobada)))
      .orderBy(asc(proformas.number), asc(shipments.code));
  },

  /** El casillero con los medios de pago que le permite su tarifa. */
  async clientWithRate(clientId: string) {
    const [row] = await db
      .select({
        clientId: clients.id,
        clientCode: clients.code,
        clientName: users.name,
        rateId: clientRates.id,
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
        method: paymentGroups.method,
        amount: paymentGroups.amount,
        surchargeAmount: paymentGroups.surchargeAmount,
        currency: paymentGroups.currency,
        exchangeRate: paymentGroups.exchangeRate,
        gatewayReference: paymentGroups.gatewayReference,
        createdAt: paymentGroups.createdAt,
        createdByName: creatorName,
      })
      .from(paymentGroups)
      .innerJoin(clients, eq(paymentGroups.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
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
   * formulario sin pagar).
   */
  async removeGroup(id: string) {
    await db.transaction(async (tx) => {
      await tx.delete(payments).where(eq(payments.groupId, id));
      await tx.delete(paymentGroups).where(eq(paymentGroups.id, id));
    });
  },

  /** Los abonos de un grupo: uno por tramite. */
  async groupPayments(groupId: string) {
    return db
      .select({
        id: payments.id,
        shipmentId: payments.shipmentId,
        status: payments.status,
        amount: payments.amount,
        surchargeAmount: payments.surchargeAmount,
        currency: payments.currency,
        exchangeRate: payments.exchangeRate,
        confirmedAt: payments.confirmedAt,
      })
      .from(payments)
      .where(eq(payments.groupId, groupId));
  },

  /** Numeros de las proformas que cubre un grupo (por sus tramites). */
  async groupProformaNumbers(groupId: string): Promise<number[]> {
    const rows = await db
      .selectDistinct({ number: proformas.number })
      .from(payments)
      .innerJoin(proformaShipments, eq(proformaShipments.shipmentId, payments.shipmentId))
      .innerJoin(proformas, eq(proformas.id, proformaShipments.proformaId))
      .where(eq(payments.groupId, groupId));
    return rows
      .map((r) => r.number)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
  },

  /**
   * Crea el grupo y sus abonos en UNA transaccion: un grupo sin abonos es un
   * cobro que no cobra nada, y unos abonos sin grupo son un cobro que nadie puede
   * volver a juntar.
   */
  async insertGroupWithPayments(
    group: typeof paymentGroups.$inferInsert,
    lines: (groupId: string) => (typeof payments.$inferInsert)[],
  ): Promise<string> {
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(paymentGroups).values(group).returning({ id: paymentGroups.id });
      if (!row) throw new Error('No se pudo crear el cobro.');
      await tx.insert(payments).values(lines(row.id));
      return row.id;
    });
  },

  /**
   * Cobros con tarjeta del casillero que quedaron ABIERTOS y sin usar: todos sus
   * abonos siguen en `iniciado`. Los barre `start` antes de abrir otro formulario
   * (cada pestaña cerrada deja su intento vivo en Onvo).
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
};
