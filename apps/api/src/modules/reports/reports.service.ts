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
  asRealCosts,
  breakdownByCategory,
  can,
  chargeBasisFor,
  chargeBasisIn,
  collectionStatus,
  convertMoney,
  depositDifference,
  formatProformaNumber,
  grossProfit,
  internationalFreightUsd,
  marginPercentage,
  monthOf,
  outstandingFor,
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
   * (`chargeCurrencyOf`, la de su proforma), la misma que usa la guarda de
   * salida a ruta. Un reporte que dijera "Pendiente" de un paquete que el
   * sistema deja salir por pagado seria peor que no tener la columna.
   */
  const basis = chargeBasisFor(row);

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
 *
 * COSTO NETO Y PROFIT. Las columnas de costo (IMPUESTOS, OTROS, COSTOS
 * ASOCIADOS) se desglosan con el costo NETO de cada linea, y MONTO FACTURA sigue
 * siendo lo facturado. COSTO NETO es la suma de las columnas de costo que se ven
 * en la fila, y el PROFIT es MONTO FACTURA menos COSTO NETO en los dos flujos:
 * quien abre el CSV puede rehacer la resta con las columnas que tiene delante.
 *
 * MES es el mes de FACTURACION (aprobacion de la proforma) en los dos flujos:
 * el reporte se usa para cerrar meses, y eso lo fija la factura, no la entrega.
 */
async function serviceReportRows(query: ReportQuery): Promise<ReportRow[]> {
  const rows = await reportsRepo.serviceReportRows(query);
  const isPaqueteria =
    query.kind === ReportKind.PaqueteriaFull || query.kind === ReportKind.PaqueteriaOperativo;

  return rows.map((row) => {
    const realLines = asRealCosts(row.costs);
    const collection = collectionColumns(row);
    const common = {
      code: row.code,
      clientName: row.clientName,
      tracking: row.tracking,
      description: row.description,
      state: STATE_LABELS[row.state],
      /**
       * PROFORMA es el numero de la proforma APROBADA en la que se facturo el
       * tramite. Vacio mientras siga en borrador: un borrador no es un documento
       * emitido.
       */
      proforma: row.proformaSequence === null ? null : formatProformaNumber(row.proformaSequence),
      billingNotes: row.billingNotes,
      // FECHA FACTURACION = cuando se aprobaron los costos, que es cuando la
      // factura queda emitida y congelada. De ahi sale el MES.
      month: monthOf(row.costsApprovedAt),
      /**
       * FE: con el modulo de proformas la factura electronica es una por proforma
       * y se anota en ella. El campo del tramite queda para lo facturado antes.
       */
      electronicInvoiceNumber: row.proformaElectronicInvoiceNumber ?? row.electronicInvoiceNumber,
      ...collection,
    };

    if (isPaqueteria) {
      const costs = breakdownByCategory(realLines, Currency.USD);
      const freight = internationalFreightUsd(row.weightKg, row.freightRateUsdPerKg);
      const netCost = totalCostUsd(freight, costs.impuestos, costs.otros);
      // GROSS PROFIT = MONTO FACTURA - COSTO NETO (transporte + impuestos +
      // otros). Sin COSTO NETO (falta peso o tarifa) el profit sale vacio, no inflado.
      const profit = grossProfit(row.invoiceTotalUsd, netCost, Currency.USD);

      return project(query.kind, {
        ...common,
        service: SHIPMENT_TYPE_LABELS[ShipmentType.Paqueteria],
        invoiceTotalUsd: row.invoiceTotalUsd,
        cnee: row.cnee,
        store: row.store,
        carrier: row.carrier,
        miamiArrivalAt: row.miamiArrivalAt,
        hawb: row.hawb,
        weightKg: row.weightKg,
        deliveredAt: row.deliveredAt,
        proformaApprovedAt: row.proformaApprovedAt,
        internationalFreightUsd: freight,
        taxesUsd: costs.impuestos,
        othersUsd: costs.otros,
        netCostUsd: netCost,
        grossProfitUsd: profit,
        marginPct: marginPercentage(profit, row.invoiceTotalUsd),
      });
    }

    /**
     * Agenciamiento y transporte se reporta en COLONES, la moneda de lectura del
     * staff, aunque su proforma se cobre en dolares (`chargeCurrencyOf`). Todo
     * sale en CRC desde el origen (factura congelada en CRC, desglose y abonos
     * convertidos con SU tasa) en vez de convertir el resultado. En un tramite
     * cobrado en dolares, DIF puede dejar unos colones de redondeo aunque el
     * ESTATUS COBRO (que si usa la moneda de cobro) diga pagado.
     */
    const costs = breakdownByCategory(realLines, Currency.CRC);
    const deposited = settledAmount(row.payments, Currency.CRC);
    // COSTO NETO = COSTOS ASOCIADOS + IMPUESTOS, sumado desde las dos columnas ya
    // redondeadas para que la fila cuadre a simple vista.
    const netCost = roundMoney(costs.otros + costs.impuestos, Currency.CRC);
    const profit = grossProfit(row.invoiceTotalCrc, netCost, Currency.CRC);

    return project(query.kind, {
      ...common,
      shipmentType: SHIPMENT_TYPE_LABELS[row.shipmentType],
      warehouse: row.warehouse,
      dua: row.dua,
      invoicedAt: row.costsApprovedAt,
      invoiceTotalCrc: row.invoiceTotalCrc,
      proformaApprovedAt: row.proformaApprovedAt,
      depositedCrc: deposited,
      differenceCrc: depositDifference(row.invoiceTotalCrc, deposited, Currency.CRC),
      associatedCostsCrc: costs.otros,
      taxesCrc: costs.impuestos,
      netCostCrc: netCost,
      profitCrc: profit,
      marginPct: marginPercentage(profit, row.invoiceTotalCrc),
    });
  });
}

/**
 * Filas del estado de cuenta: una por proforma emitida.
 *
 * Todo se calcula en la moneda en que se COBRA la proforma, con los mismos
 * puntos que usa el modulo de pagos (`settledAmount`, `outstandingFor`,
 * `collectionStatus`): un reporte que dijera "pendiente" de una proforma que el
 * sistema da por pagada seria peor que no tener el reporte.
 *
 * El equivalente en dolares no se recalcula con la tasa del dia: FACTURADO (USD)
 * es el total congelado en la aprobacion, y el SALDO (USD) convierte el saldo con
 * la tasa de esa misma proforma (regla M5). Si la proforma se cobra en dolares
 * no hay conversion que hacer.
 */
async function financialRows(query: ReportQuery): Promise<ReportRow[]> {
  const rows = await reportsRepo.billedProformas(query);
  return rows.map((row) => {
    const invoiced = row.currency === Currency.USD ? row.totalUsd : row.totalCrc;
    const basis = chargeBasisIn(row.currency, invoiced);
    const settled = settledAmount(row.payments, row.currency);
    const balance = outstandingFor(settled, basis);
    const balanceUsd =
      row.currency === Currency.USD
        ? balance
        : row.exchangeRate == null
          ? null
          : convertMoney(balance, Currency.CRC, Currency.USD, row.exchangeRate);

    const weights = row.shipments
      .map((s) => s.weightKg)
      .filter((w): w is number => w != null);

    return project(query.kind, {
      clientCode: row.clientCode,
      miamiAccount: row.miamiAccount,
      clientName: row.clientName,
      proforma: row.number === null ? null : formatProformaNumber(row.number),
      approvedAt: row.approvedAt,
      electronicInvoiceNumber: row.electronicInvoiceNumber,
      shipmentCount: row.shipments.length,
      // Sin ningun peso (Agenciamiento, Transporte) la celda queda vacia, no en 0.
      weightKg: weights.length === 0 ? null : Math.round(weights.reduce((a, b) => a + b, 0) * 100) / 100,
      currency: row.currency,
      invoiced,
      settled,
      balance,
      invoicedUsd: row.totalUsd,
      balanceUsd,
      paymentStatus: COLLECTION_STATUS_LABELS[collectionStatus(row.payments, basis)],
      paidAt: row.paidAt,
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

    if (query.kind === ReportKind.Financiero) return financialRows(query);

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
