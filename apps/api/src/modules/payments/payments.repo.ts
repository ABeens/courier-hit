/**
 * Acceso a datos de los pagos. Dueño de la tabla `payments`; lee `users` solo
 * para poner nombre a quien registro y quien confirmo cada abono.
 */
import { aliasedTable, and, desc, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { PaymentStatus } from '@courier/shared';
import { db } from '../../core/db';
import { users } from '../auth/auth.schema';
import { payments } from './payments.schema';

/** Dos joins contra `users` en la misma consulta: hacen falta dos alias. */
const creator = aliasedTable(users, 'payment_creator');
const confirmer = aliasedTable(users, 'payment_confirmer');

const columns = {
  id: payments.id,
  shipmentId: payments.shipmentId,
  method: payments.method,
  status: payments.status,
  amount: payments.amount,
  currency: payments.currency,
  exchangeRate: payments.exchangeRate,
  bankAccount: payments.bankAccount,
  receiptNumber: payments.receiptNumber,
  depositedAt: payments.depositedAt,
  receiptFileKey: payments.receiptFileKey,
  gatewayReference: payments.gatewayReference,
  note: payments.note,
  confirmedAt: payments.confirmedAt,
  createdAt: payments.createdAt,
  createdByName: creator.name,
  confirmedByName: confirmer.name,
};

function baseQuery() {
  return db
    .select(columns)
    .from(payments)
    .leftJoin(creator, eq(payments.createdBy, creator.id))
    .leftJoin(confirmer, eq(payments.confirmedBy, confirmer.id));
}

export const paymentsRepo = {
  /** Pagos de un tramite, del mas reciente al mas antiguo. */
  async listByShipment(shipmentId: string) {
    return baseQuery().where(eq(payments.shipmentId, shipmentId)).orderBy(desc(payments.createdAt));
  },

  /** Bandeja del staff: todos los pagos, opcionalmente filtrados por situacion. */
  async list(filters: { shipmentId?: string; status?: PaymentStatus }) {
    const conds: SQL[] = [];
    if (filters.shipmentId) conds.push(eq(payments.shipmentId, filters.shipmentId));
    if (filters.status) conds.push(eq(payments.status, filters.status));

    const query = baseQuery().orderBy(desc(payments.createdAt));
    return conds.length > 0 ? query.where(and(...conds)) : query;
  },

  async findById(id: string) {
    const [row] = await baseQuery().where(eq(payments.id, id)).limit(1);
    return row ?? null;
  },

  /**
   * Solo lo necesario para decidir si un tramite esta cubierto: monto, moneda,
   * tasa y situacion. La suma la hace `isSettled` de @courier/shared, que es el
   * punto unico de esa cuenta.
   */
  async settlementView(shipmentId: string) {
    return db
      .select({
        amount: payments.amount,
        currency: payments.currency,
        exchangeRate: payments.exchangeRate,
        status: payments.status,
      })
      .from(payments)
      .where(eq(payments.shipmentId, shipmentId));
  },

  async insert(values: typeof payments.$inferInsert) {
    const [row] = await db.insert(payments).values(values).returning({ id: payments.id });
    if (!row) throw new Error('No se pudo registrar el pago.');
    return row.id;
  },

  async update(id: string, patch: Partial<typeof payments.$inferInsert>) {
    const [row] = await db
      .update(payments)
      .set(patch)
      .where(eq(payments.id, id))
      .returning({ id: payments.id });
    return row ?? null;
  },
};
