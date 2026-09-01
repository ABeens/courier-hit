/**
 * Generacion de reportes (docs/manuales/roles.md §2).
 *
 * Tres decisiones que viven aqui y en ningun otro lado:
 *
 * 1. EL PERMISO DECIDE QUE COLUMNAS SE VEN, no solo si se puede pedir. El corte
 *    Basico/Completo existe para no exponer montos al personal no administrador,
 *    asi que recortar en la UI no bastaria: el servidor arma la fila con las
 *    columnas del reporte y no con todo lo que tiene a mano.
 * 2. LAS COLUMNAS SALEN DE @courier/shared. `REPORT_COLUMNS` es la fuente unica:
 *    la tabla de la pantalla y el CSV descargado tienen las mismas, en el mismo
 *    orden, sin repetir la lista.
 * 3. LOS MONTOS VIAJAN COMO NUMEROS CRUDOS. El formateo con simbolo de moneda es
 *    presentacion (`formatMoney`); meterlo en el CSV convertiria una columna
 *    calculable en texto y rompería cualquier hoja de calculo que la sume.
 */
import {
  BANK_ACCOUNT_LABELS,
  COLLECTION_STATUS_LABELS,
  Currency,
  PaymentStatus,
  REPORT_COLUMNS,
  REPORT_PERMISSIONS,
  REPORT_SHIPMENT_TYPES,
  ReportKind,
  SHIPMENT_TYPE_LABELS,
  STATE_LABELS,
  ShipmentType,
  breakdownByCategory,
  can,
  chargeBasisFor,
  collectionStatus,
  depositDifference,
  grossProfitUsd,
  internationalFreightUsd,
  marginPercentage,
  monthOf,
  roundMoney,
  settledAmount,
  settledAt,
  totalCostUsd,
} from '@courier/shared';
import type { ReportDto, ReportQuery, ReportRow, Session } from '@courier/shared';
import { AuthErrors } from '../../core/errors';
import { reportsRepo } from './reports.repo';

/**
 * Deja en la fila SOLO las columnas del reporte. Es la barrera de la decision 1:
 * aunque la consulta traiga de mas, lo que sale es lo que el reporte declara.
 */
function project(kind: ReportKind, source: Record<string, unknown>): ReportRow {
  const row: ReportRow = {};
  for (const column of REPORT_COLUMNS[kind]) {
    const value = source[column.key];
    row[column.key] =
      value === undefined || value === null
        ? null
        : value instanceof Date
          ? value.toISOString()
          : typeof value === 'number' || typeof value === 'string'
            ? value
            : String(value);
  }
  return row;
}

/**
 * Escapa un valor para CSV: comillas dobladas y el campo entrecomillado si lleva
 * separador, comillas o salto de linea. Punto unico del escapado.
 */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Acota el filtro de tipo de tramite a los que ese reporte cubre.
 *
 * INTERSECCION y no reemplazo: el reporte de Agenciamiento incluye aereo y
 * maritimo, y el usuario tiene que poder pedir solo los aereos dentro de el. Lo
 * que no puede es sacar un paquete de Paqueteria por ahi, porque la mitad de sus
 * columnas no existen en ese flujo.
 *
 * Si la interseccion queda vacia (pidio Paqueteria dentro del reporte de
 * Agenciamiento) se deja el acotamiento del reporte: devolver cero filas seria
 * correcto pero indistinguible de "no hay datos en ese rango".
 */
function restrictTypes(query: ReportQuery, allowed: readonly ShipmentType[]): ReportQuery {
  const asked = query.shipmentType;
  const kept = asked ? allowed.filter((t) => asked.includes(t)) : allowed;
  const final = kept.length > 0 ? kept : allowed;
  return { ...query, shipmentType: final as [ShipmentType, ...ShipmentType[]] };
}

/** Fila cruda de un reporte por servicio, tal como la arma el repo. */
type ServiceRow = Awaited<ReturnType<typeof reportsRepo.serviceReportRows>>[number];

/**
 * Columnas de COBRO, iguales en los dos reportes por servicio (ESTATUS COBRO,
 * CUENTA, COMPROBANTE y la fecha de pago).
 *
 * Cuenta y comprobante salen del ultimo abono CONFIRMADO y no de todos: son
 * datos de un deposito concreto, y concatenar los de tres abonos parciales daria
 * una celda que no identifica ninguno. Si no hay ninguno confirmado se cae al
 * ultimo registrado, que es el que el administrador esta esperando validar.
 */
function collectionColumns(row: ServiceRow) {
  const confirmed = row.payments.filter((p) => p.status === PaymentStatus.Confirmado);
  const reference = confirmed.at(-1) ?? row.payments.at(-1) ?? null;

  /**
   * El estatus de cobro se decide en la moneda con la que se cobra el tramite
   * (`chargeCurrencyFor`), la misma que usa la guarda de salida a ruta. Un
   * reporte que dijera "Pendiente" de un paquete que el sistema deja salir por
   * pagado seria peor que no tener la columna.
   */
  const basis = chargeBasisFor(row.shipmentType, row);

  return {
    collectionStatus: COLLECTION_STATUS_LABELS[collectionStatus(row.payments, basis)],
    bankAccount: reference?.bankAccount ? BANK_ACCOUNT_LABELS[reference.bankAccount] : null,
    /**
     * El numero de comprobante si lo hay; si no, se dice que existe un archivo
     * adjunto. La clave del almacen NO viaja: es opaca, no sirve para nada fuera
     * del sistema y en un CSV solo seria ruido.
     */
    receipt: reference?.receiptNumber ?? (reference?.receiptFileKey ? 'Adjunto' : null),
    paidAt: settledAt(row.payments, basis),
  };
}

/**
 * Filas de los reportes por servicio. Las dos formas se arman juntas porque
 * comparten el 70% de las columnas y toda la derivacion de cobro; lo que cambia
 * es que costo mide cada una:
 *
 *   - PAQUETERIA separa IMPUESTOS de OTROS y suma aparte el transporte
 *     internacional, que no sale de las lineas sino de la tarifa congelada.
 *   - AGENCIAMIENTO agrupa todo lo trasladado en COSTOS ASOCIADOS.
 *
 * El recorte del reporte operativo NO se hace aqui: lo aplica `project` con las
 * columnas declaradas, que es la barrera unica. Calcular de mas y proyectar de
 * menos es a proposito; la alternativa —dos caminos de calculo— es como se
 * acaban filtrando columnas que no debian salir.
 */
async function serviceReportRows(query: ReportQuery): Promise<ReportRow[]> {
  const rows = await reportsRepo.serviceReportRows(query);
  const isPaqueteria =
    query.kind === ReportKind.PaqueteriaFull || query.kind === ReportKind.PaqueteriaOperativo;

  return rows.map((row) => {
    const costs = breakdownByCategory(row.costs, Currency.USD);
    const collection = collectionColumns(row);
    const common = {
      code: row.code,
      clientName: row.clientName,
      tracking: row.tracking,
      description: row.description,
      state: STATE_LABELS[row.state],
      // PROFORMA es el id del tramite: una proforma por tramite, sin secuencia aparte.
      proforma: row.code,
      invoiceTotalUsd: row.invoiceTotalUsd,
      billingNotes: row.billingNotes,
      electronicInvoiceNumber: row.electronicInvoiceNumber,
      ...collection,
    };

    if (isPaqueteria) {
      const freight = internationalFreightUsd(row.weightKg, row.freightRateUsdPerLb);
      const total = totalCostUsd(freight, costs.impuestos, costs.otros);
      const profit = grossProfitUsd(row.invoiceTotalUsd, total);

      return project(query.kind, {
        ...common,
        service: SHIPMENT_TYPE_LABELS[ShipmentType.Paqueteria],
        store: row.store,
        carrier: row.carrier,
        miamiArrivalAt: row.miamiArrivalAt,
        hawb: row.hawb,
        weightKg: row.weightKg,
        deliveredAt: row.deliveredAt,
        // MES sale de la FECHA DE ENTREGA en Paqueteria (campo 13 del mapeo).
        month: monthOf(row.deliveredAt),
        internationalFreightUsd: freight,
        taxesUsd: costs.impuestos,
        othersUsd: costs.otros,
        totalCostUsd: total,
        grossProfitUsd: profit,
        marginPct: marginPercentage(profit, row.invoiceTotalUsd),
      });
    }

    const deposited = settledAmount(row.payments, Currency.USD);
    const profit = grossProfitUsd(row.invoiceTotalUsd, costs.passThrough);

    return project(query.kind, {
      ...common,
      shipmentType: SHIPMENT_TYPE_LABELS[row.shipmentType],
      warehouse: row.warehouse,
      dua: row.dua,
      // FECHA FACTURACIÓN = cuando se aprobaron los costos, que es cuando la
      // factura queda emitida y congelada. De ahi sale el MES (campo 10).
      invoicedAt: row.costsApprovedAt,
      month: monthOf(row.costsApprovedAt),
      depositedUsd: deposited,
      differenceUsd: depositDifference(row.invoiceTotalUsd, deposited, Currency.USD),
      associatedCostsUsd: costs.passThrough,
      profitUsd: profit,
      marginPct: marginPercentage(profit, row.invoiceTotalUsd),
    });
  });
}

/** Serializa el reporte a CSV con BOM, para que Excel respete los acentos. */
export function toCsv(report: ReportDto): string {
  const header = report.columns.map((c) => csvCell(c.label)).join(',');
  const lines = report.rows.map((row) =>
    report.columns.map((c) => csvCell(row[c.key] ?? null)).join(','),
  );
  return `﻿${[header, ...lines].join('\r\n')}`;
}

export const reportsService = {
  /**
   * Genera el reporte pedido. El permiso se comprueba AQUI y no en un middleware
   * porque depende del `kind` que viene en la query: una barrera fija dejaria
   * pasar al financiero a un reporte operativo o al reves.
   */
  async generate(session: Session, query: ReportQuery): Promise<ReportDto> {
    if (!can(session.role, REPORT_PERMISSIONS[query.kind])) throw AuthErrors.forbidden();

    const rows = await this.rowsFor(query);
    return { kind: query.kind, columns: REPORT_COLUMNS[query.kind], rows };
  },

  /** Filas crudas de cada reporte, ya proyectadas a sus columnas. */
  async rowsFor(query: ReportQuery): Promise<ReportRow[]> {
    const serviceTypes = REPORT_SHIPMENT_TYPES[query.kind];
    if (serviceTypes) return serviceReportRows(restrictTypes(query, serviceTypes));

    if (query.kind === ReportKind.Transaccional) {
      const events = await reportsRepo.stateMovements(query);
      return events.map((row) =>
        project(query.kind, {
          ...row,
          shipmentType: SHIPMENT_TYPE_LABELS[row.shipmentType],
          state: STATE_LABELS[row.state],
        }),
      );
    }

    if (query.kind === ReportKind.Financiero) {
      const rows = await reportsRepo.billedShipments(query);
      return rows.map((row) => {
        /**
         * El abonado se calcula con `settledAmount`, el mismo punto que usa el
         * modulo de pagos para decidir si un tramite esta cubierto. Sumar aqui
         * por separado abriria la puerta a que el reporte y el sistema
         * discreparan sobre cuanto debe un cliente.
         */
        const settledCrc = settledAmount(row.payments, Currency.CRC);
        const invoiced = row.invoiceTotalCrc ?? 0;
        return project(query.kind, {
          ...row,
          state: STATE_LABELS[row.state],
          settledCrc,
          balanceCrc: roundMoney(invoiced - settledCrc, Currency.CRC),
        });
      });
    }

    const rows = await reportsRepo.shipments(query);
    return rows.map((row) =>
      project(query.kind, {
        ...row,
        shipmentType: SHIPMENT_TYPE_LABELS[row.shipmentType],
        state: STATE_LABELS[row.state],
      }),
    );
  },
};
