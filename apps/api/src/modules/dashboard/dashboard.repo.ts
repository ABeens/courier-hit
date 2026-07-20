/**
 * Conteos del resumen operativo. Solo lectura y solo agregados: el detalle lo
 * sirve el dashboard de tramites.
 */
import { count, desc, eq } from 'drizzle-orm';
import { PaymentStatus } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { payments } from '../payments/payments.schema';
import { shipments } from '../shipments/shipments.schema';

export const dashboardRepo = {
  /** Tramites por estado. La pantalla arma las colas con esto. */
  async countByState() {
    return db
      .select({ state: shipments.state, total: count() })
      .from(shipments)
      .groupBy(shipments.state);
  },

  async countByType() {
    return db
      .select({ shipmentType: shipments.shipmentType, total: count() })
      .from(shipments)
      .groupBy(shipments.shipmentType);
  },

  /** Depositos subidos por clientes que el staff aun no valida. */
  async pendingPaymentCount() {
    const [row] = await db
      .select({ total: count() })
      .from(payments)
      .where(eq(payments.status, PaymentStatus.Pendiente));
    return row?.total ?? 0;
  },

  /** Ultimos movimientos de alta, para dar contexto de "que esta entrando". */
  async recent() {
    return db
      .select({
        id: shipments.id,
        code: shipments.code,
        shipmentType: shipments.shipmentType,
        state: shipments.state,
        tracking: shipments.tracking,
        clientName: users.name,
        createdAt: shipments.createdAt,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .orderBy(desc(shipments.createdAt))
      .limit(10);
  },
};
