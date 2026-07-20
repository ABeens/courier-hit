/**
 * Acceso a datos de los costos de un tramite.
 *
 * El guardado es un REEMPLAZO ATOMICO (borrar + insertar en una transaccion): el
 * juego de lineas se recalcula completo en el servicio, y un estado intermedio
 * con la mitad de las lineas viejas y la mitad nuevas no representaria ninguna
 * factura real.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { users } from '../auth/auth.schema';
import { shipments } from '../shipments/shipments.schema';
import { shipmentCosts } from './shipment-cost.schema';

const columns = {
  id: shipmentCosts.id,
  costServiceId: shipmentCosts.costServiceId,
  label: shipmentCosts.label,
  source: shipmentCosts.source,
  percentage: shipmentCosts.percentage,
  amount: shipmentCosts.amount,
  currency: shipmentCosts.currency,
  exchangeRate: shipmentCosts.exchangeRate,
  createdAt: shipmentCosts.createdAt,
};

export const costsRepo = {
  /** Lineas de un tramite, en el orden en que se cargaron. */
  async listLines(shipmentId: string) {
    return db
      .select(columns)
      .from(shipmentCosts)
      .where(eq(shipmentCosts.shipmentId, shipmentId))
      .orderBy(shipmentCosts.createdAt);
  },

  /** Reemplaza TODAS las lineas del tramite por las nuevas, en una transaccion. */
  async replaceLines(shipmentId: string, lines: (typeof shipmentCosts.$inferInsert)[]) {
    await db.transaction(async (tx) => {
      await tx.delete(shipmentCosts).where(eq(shipmentCosts.shipmentId, shipmentId));
      if (lines.length > 0) await tx.insert(shipmentCosts).values(lines);
    });
    return this.listLines(shipmentId);
  },

  /**
   * Congela el total aprobado en el tramite. Guarda las DOS monedas juntas
   * (regla M2) y quien/cuando aprobo: a partir de aqui la factura no se toca.
   */
  async freezeInvoice(
    shipmentId: string,
    totals: { usd: number; crc: number },
    approvedBy: string,
  ) {
    await db
      .update(shipments)
      .set({
        invoiceTotalUsd: totals.usd,
        invoiceTotalCrc: totals.crc,
        costsApprovedAt: new Date(),
        costsApprovedBy: approvedBy,
        updatedAt: new Date(),
      })
      .where(eq(shipments.id, shipmentId));
  },

  /** Estado de aprobacion del tramite (con el nombre de quien aprobo). */
  async approval(shipmentId: string) {
    const [row] = await db
      .select({
        approvedAt: shipments.costsApprovedAt,
        approvedByName: users.name,
        invoiceTotalUsd: shipments.invoiceTotalUsd,
        invoiceTotalCrc: shipments.invoiceTotalCrc,
      })
      .from(shipments)
      .leftJoin(users, eq(shipments.costsApprovedBy, users.id))
      .where(eq(shipments.id, shipmentId))
      .limit(1);
    return row ?? null;
  },
};
