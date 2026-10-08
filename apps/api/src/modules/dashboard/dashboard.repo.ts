/**
 * Conteos del resumen operativo. Solo lectura y solo agregados: el detalle lo
 * sirve el dashboard de tramites.
 *
 * Los descartados quedan fuera de TODO: estan archivados, no son operacion, y
 * el listado al que lleva cada cifra tambien los esconde. Contarlos aqui hacia
 * que el cuadro dijera una cifra y la pantalla destino otra.
 */
import { and, count, countDistinct, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { PaymentStatus, State } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { payments } from '../payments/payments.schema';
import { proformaShipments } from '../proformas/proformas.schema';
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

  /**
   * Tramites parados en "Facturacion en proceso" que YA tienen factura.
   *
   * Solo Transporte llega aqui: es el unico flujo que factura y cobra en el mismo
   * estado, asi que al aprobar los costos no se mueve. Se descuentan del cuadro
   * "Por facturar" porque ahi ya no hay nada que facturar, y porque si no la
   * cifra del cuadro no cuadraba con la cola a la que lleva.
   */
  async billedInBillingCount() {
    const [row] = await db
      .select({ total: count() })
      .from(shipments)
      .where(
        and(
          eq(shipments.state, State.FacturacionEnProceso),
          isNotNull(shipments.invoiceTotalCrc),
          isNull(shipments.discardedAt),
        ),
      );
    return row?.total ?? 0;
  },

  async countByType() {
    return db
      .select({ shipmentType: shipments.shipmentType, total: count() })
      .from(shipments)
      .where(isNull(shipments.discardedAt))
      .groupBy(shipments.shipmentType);
  },

  /**
   * PROFORMAS con un pago que el administrador aun no valida.
   *
   * Se cuentan proformas y no abonos ni tramites: el pago se valida desde el
   * detalle de la proforma, y el cuadro lleva a la bandeja de Proformas con
   * `pendingValidation=true`. Es el mismo EXISTS que ese filtro, para que el
   * cuadro y la pantalla de destino digan la misma cifra.
   */
  async pendingPaymentCount() {
    const [row] = await db
      .select({ total: countDistinct(proformaShipments.proformaId) })
      .from(proformaShipments)
      .innerJoin(payments, eq(payments.shipmentId, proformaShipments.shipmentId))
      .where(eq(payments.status, PaymentStatus.Pendiente));
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
