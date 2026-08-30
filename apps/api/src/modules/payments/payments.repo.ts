/**
 * Acceso a datos de los pagos. Dueño de la tabla `payments`; lee `users` solo
 * para poner nombre a quien registro y quien confirmo cada abono.
 */
import { aliasedTable, and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { PaymentMethod, PaymentStatus, UNRESOLVED_PAYMENT_STATUSES } from '@courier/shared';
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
  /**
   * Pagos de un tramite, del mas reciente al mas antiguo.
   *
   * Los cobros INICIADOS quedan fuera: son formularios de tarjeta abiertos, no
   * abonos. En la lista del cliente se leerian como un cargo que nunca ocurrio, y
   * en la del staff, como algo que revisar.
   */
  async listByShipment(shipmentId: string) {
    return baseQuery()
      .where(and(eq(payments.shipmentId, shipmentId), ne(payments.status, PaymentStatus.Iniciado)))
      .orderBy(desc(payments.createdAt));
  },

  /** Bandeja del staff: todos los pagos, opcionalmente filtrados por situacion. */
  async list(filters: { shipmentId?: string; status?: PaymentStatus }) {
    const conds: SQL[] = [ne(payments.status, PaymentStatus.Iniciado)];
    if (filters.shipmentId) conds.push(eq(payments.shipmentId, filters.shipmentId));
    if (filters.status) conds.push(eq(payments.status, filters.status));

    return baseQuery().where(and(...conds)).orderBy(desc(payments.createdAt));
  },

  /**
   * Cobros con tarjeta abiertos y sin intentar de un tramite. Los busca `start`
   * para tirarlos antes de abrir otro: si no, cada formulario que el cliente
   * abandona (cerrar la pestaña, quedarse sin bateria) deja una fila muerta.
   */
  async openCardAttempts(shipmentId: string) {
    return db
      .select({ id: payments.id, gatewayReference: payments.gatewayReference })
      .from(payments)
      .where(
        and(
          eq(payments.shipmentId, shipmentId),
          eq(payments.method, PaymentMethod.Tarjeta),
          eq(payments.status, PaymentStatus.Iniciado),
        ),
      );
  },

  async findById(id: string) {
    const [row] = await baseQuery().where(eq(payments.id, id)).limit(1);
    return row ?? null;
  },

  /**
   * Pago por la referencia de la pasarela. Es la unica via que tiene el webhook
   * para saber a que abono se refiere el cobro: Onvo conoce su id de intento, no
   * el nuestro.
   */
  async findByGatewayReference(reference: string) {
    const [row] = await baseQuery().where(eq(payments.gatewayReference, reference)).limit(1);
    return row ?? null;
  },

  /**
   * Confirma o rechaza un pago SOLO si su desenlace sigue sin escribirse, en una
   * sola sentencia.
   *
   * Es la idempotencia del webhook. Onvo reintenta las entregas fallidas y su
   * evento no trae id propio, asi que el mismo cobro puede llegar dos veces; leer y
   * despues escribir dejaria una ventana para aplicarlo dos veces. El `WHERE` por
   * situacion hace que la segunda pasada no toque ninguna fila y devuelva null,
   * que el servicio lee como "ya estaba resuelto".
   *
   * Entran las DOS situaciones sin resolver, no solo `Pendiente`: el webhook
   * puede adelantarse al aviso del navegador y encontrarse el cobro todavia como
   * `Iniciado`. Exigir `Pendiente` ahi habria dejado sin aplicar un cobro real.
   */
  async resolveIfPending(
    id: string,
    patch: { status: PaymentStatus; note?: string | null; confirmedAt: Date },
  ) {
    const [row] = await db
      .update(payments)
      .set(patch)
      .where(and(eq(payments.id, id), inArray(payments.status, [...UNRESOLVED_PAYMENT_STATUSES])))
      .returning({ id: payments.id });
    return row ?? null;
  },

  /**
   * El cargo salio hacia la pasarela: el cobro deja de ser un formulario abierto
   * y pasa a contar como abono a la espera del webhook. Condicionado a `Iniciado`
   * para no pisar un desenlace que ya llego (el webhook puede ganar la carrera).
   */
  async markSubmitted(id: string) {
    const [row] = await db
      .update(payments)
      .set({ status: PaymentStatus.Pendiente })
      .where(and(eq(payments.id, id), eq(payments.status, PaymentStatus.Iniciado)))
      .returning({ id: payments.id });
    return row ?? null;
  },

  /** Borra un pago. Solo para deshacer uno que nunca llego a existir de verdad. */
  async remove(id: string) {
    await db.delete(payments).where(eq(payments.id, id));
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
