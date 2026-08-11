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
  category: shipmentCosts.category,
  electronicInvoiceCode: shipmentCosts.electronicInvoiceCode,
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
   *
   * Junto al total se congela la TARIFA de transporte internacional vigente. No
   * entra en ninguna cifra de la factura (el cliente no la ve): es el costo con
   * el que el reporte calculara el margen de este paquete, y guardarlo aqui es lo
   * que impide que subir la tarifa manana reescriba la rentabilidad de los meses
   * ya cerrados. `null` cuando no aplica (no es Paqueteria) o cuando nadie ha
   * fijado la tarifa todavia.
   */
  async freezeInvoice(
    shipmentId: string,
    totals: { usd: number; crc: number },
    approvedBy: string,
    freightRateUsdPerLb: number | null,
  ) {
    await db
      .update(shipments)
      .set({
        invoiceTotalUsd: totals.usd,
        invoiceTotalCrc: totals.crc,
        freightRateUsdPerLb,
        costsApprovedAt: new Date(),
        costsApprovedBy: approvedBy,
        updatedAt: new Date(),
      })
      .where(eq(shipments.id, shipmentId));
  },

  /**
   * Descongela la factura: deja el tramite como si nunca se hubieran aprobado los
   * costos. Es el inverso exacto de `freezeInvoice`, y limpia los SEIS campos que
   * aquella escribe: dejar `costsApprovedBy` o una sola de las dos monedas daria
   * un tramite medio aprobado, que ninguna consulta sabe leer.
   *
   * La tarifa de flete se limpia con el resto: al reaprobar se vuelve a tomar la
   * vigente, que es la que corresponde a la factura que de verdad se emitio.
   *
   * Las lineas de costo NO se borran: se conservan para que el operador vea que
   * habia cargado y corrija en vez de rehacer desde cero.
   */
  async releaseInvoice(shipmentId: string) {
    await db
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
