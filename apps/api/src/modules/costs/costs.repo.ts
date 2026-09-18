/**
 * Acceso a datos de los costos de un tramite.
 *
 * El guardado es un REEMPLAZO ATOMICO (borrar + insertar en una transaccion): el
 * juego de lineas se recalcula completo en el servicio, y un estado intermedio
 * con la mitad de las lineas viejas y la mitad nuevas no representaria ninguna
 * factura real.
 */
import { eq, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { CURRENCY_DECIMALS, Currency } from '@courier/shared';
import type { CostCategory, CostLineSource } from '@courier/shared';
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

/**
 * El total de factura con el recargo YA SUMADO y redondeado a los decimales de su
 * moneda, como expresion SQL.
 *
 * El redondeo no es cosmetico y por eso no se puede dejar a la suma a secas: las
 * columnas son `doublePrecision`, asi que 105.31 + 0.35 se persiste como
 * 105.65999999999999. Ese arrastre acaba EN LA COMPARACION que decide si un
 * tramite esta pagado (`isSettled` compara el abonado contra este total con
 * `>=`), y un paquete puede quedarse retenido por una millonesima que nadie ve.
 *
 * Aplica la MISMA politica que `roundMoney` (regla M4): los decimales salen de
 * `CURRENCY_DECIMALS`, no de un numero escrito aqui. Se hace en la base y no
 * leyendo-escribiendo en el servicio para no perder la suma atomica.
 */
function bumped(column: AnyColumn, delta: number, currency: Currency): SQL<number> {
  const decimals = sql.raw(String(CURRENCY_DECIMALS[currency]));
  return sql`round((coalesce(${column}, 0) + ${delta})::numeric, ${decimals})::double precision`;
}

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
   * ASIENTA EL RECARGO DE UN COBRO CON TARJETA sobre una factura YA CONGELADA: le
   * agrega la linea de costo (la comision de la pasarela, trasladada al cliente)
   * y sube el total congelado por ese mismo importe, en las dos monedas.
   *
   * Las dos cosas van en UNA transaccion y no se pueden separar. Con la linea sin
   * el total, la factura sumaria mas de lo que dice la columna con la que se
   * decide si el tramite esta pagado; con el total sin la linea, el cliente
   * tendria una factura mas cara sin un concepto que la explique.
   *
   * IDEMPOTENTE por el unico sobre `payment_id`: la pasarela reintenta sus
   * webhooks y el mismo cobro puede llegar dos veces. El `onConflictDoNothing`
   * hace que la segunda no inserte nada, y sin insercion no se toca el total.
   * Devuelve si esta llamada fue la que asento el recargo.
   *
   * NO comprueba el estado ni el permiso: es un asiento del sistema, consecuencia
   * de un cobro que la pasarela ya aprobo, no una edicion de costos. Quien lo
   * llama es el unico camino por el que un pago pasa a confirmado.
   */
  async postSurchargeLine(input: {
    shipmentId: string;
    paymentId: string;
    label: string;
    amount: number;
    currency: Currency;
    exchangeRate: number;
    category: CostCategory;
    source: CostLineSource;
    /** Lo que sube la factura congelada, ya convertido a cada moneda. */
    invoiceDelta: { usd: number; crc: number };
  }): Promise<boolean> {
    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(shipmentCosts)
        .values({
          shipmentId: input.shipmentId,
          paymentId: input.paymentId,
          costServiceId: null,
          label: input.label,
          category: input.category,
          electronicInvoiceCode: null,
          source: input.source,
          percentage: null,
          amount: input.amount,
          currency: input.currency,
          exchangeRate: input.exchangeRate,
        })
        /**
         * EL PREDICADO DEL INDICE VA AQUI, no es decorativo: el unico sobre
         * `payment_id` es PARCIAL (solo las filas que lo llevan), y Postgres no
         * puede emparejar un `on conflict (payment_id)` a secas con un indice
         * parcial. Sin el `where`, el insert no entra en conflicto: falla, con
         * "no hay restriccion unica que coincida con la especificacion ON
         * CONFLICT", y la comision se queda sin asentar SIEMPRE.
         */
        .onConflictDoNothing({
          target: shipmentCosts.paymentId,
          where: sql`${shipmentCosts.paymentId} is not null`,
        })
        .returning({ id: shipmentCosts.id });

      if (inserted.length === 0) return false;

      await tx
        .update(shipments)
        .set({
          /**
           * Suma EN LA BASE y no leyendo-escribiendo aqui: dos webhooks a la vez
           * sobre el mismo tramite (un pago suelto y el de su grupo, o dos
           * reintentos) se pisarian el total si cada uno escribiera el que leyo.
           */
          invoiceTotalUsd: bumped(shipments.invoiceTotalUsd, input.invoiceDelta.usd, Currency.USD),
          invoiceTotalCrc: bumped(shipments.invoiceTotalCrc, input.invoiceDelta.crc, Currency.CRC),
          updatedAt: new Date(),
        })
        .where(eq(shipments.id, input.shipmentId));

      return true;
    });
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
