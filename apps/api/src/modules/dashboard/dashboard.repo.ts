/**
 * Conteos del resumen operativo. Solo lectura y solo agregados: el detalle lo
 * sirve el dashboard de tramites.
 *
 * Los descartados quedan fuera de TODO: estan archivados, no son operacion, y
 * el listado al que lleva cada cifra tambien los esconde. Contarlos aqui hacia
 * que el cuadro dijera una cifra y la pantalla destino otra.
 */
import { and, count, countDistinct, desc, eq, isNull } from 'drizzle-orm';
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
      .where(isNull(shipments.discardedAt))
      .groupBy(shipments.state);
  },

  async countByType() {
    return db
      .select({ shipmentType: shipments.shipmentType, total: count() })
      .from(shipments)
      .where(isNull(shipments.discardedAt))
      .groupBy(shipments.shipmentType);
  },

  /**
   * Tramites con un deposito subido por el cliente que el staff aun no valida.
   *
   * Se cuentan TRAMITES y no abonos: es la misma cifra que da el listado con
   * `pendingDeposit=true`, que es a donde lleva el cuadro. Un tramite con dos
   * comprobantes sin revisar es una sola fila que atender.
   */
  async pendingPaymentCount() {
    const [row] = await db
      .select({ total: countDistinct(payments.shipmentId) })
      .from(payments)
      .innerJoin(shipments, eq(payments.shipmentId, shipments.id))
      .where(and(eq(payments.status, PaymentStatus.Pendiente), isNull(shipments.discardedAt)));
    return row?.total ?? 0;
  },

  /** Ultimos movimientos de alta, para dar contexto de "que esta entrando". */
  async recent() {
    return db
      .select({
        id: shipments.id,
        code: shipments.code,
        hawb: shipments.hawb,
        shipmentType: shipments.shipmentType,
        state: shipments.state,
        tracking: shipments.tracking,
        clientName: users.name,
        createdAt: shipments.createdAt,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(isNull(shipments.discardedAt))
      .orderBy(desc(shipments.createdAt))
      .limit(10);
  },
};
