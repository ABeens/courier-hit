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
  Currency,
  REPORT_COLUMNS,
  REPORT_PERMISSIONS,
  ReportKind,
  SHIPMENT_TYPE_LABELS,
  STATE_LABELS,
  can,
  roundMoney,
  settledAmount,
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
