/**
 * Reporte en Excel (.xlsx): una hoja con las columnas del reporte, en el mismo
 * orden que la tabla de la pantalla (`REPORT_COLUMNS`).
 *
 * Los montos y pesos siguen siendo NUMEROS (se pueden sumar y filtrar), y los
 * instantes se escriben como fechas de Excel en la hora de Costa Rica: la API
 * los guarda en UTC, pero la hoja es presentacion y Excel no tiene zona horaria.
 */
import ExcelJS from 'exceljs';
import {
  BUSINESS_TIME_ZONE,
  CURRENCY_DECIMALS,
  CURRENCY_SYMBOLS,
  Currency,
  REPORT_LABELS,
} from '@courier/shared';
import type { ReportDto } from '@courier/shared';

const COLOR = {
  head: 'FF374151',
  headFill: 'FFF3F4F6',
  border: 'FFE5E7EB',
} as const;

const FONT = 'Segoe UI';

/** Instante ISO tal como lo serializa `project` (`Date#toISOString`). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const wallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * La hora local de Costa Rica de un instante, como `Date` "ingenua": exceljs
 * escribe la fecha en UTC, asi que se le entrega ya con la hora de pared.
 */
function toLocalDate(iso: string): Date {
  const parts = wallClock.formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return new Date(
    Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')),
  );
}

/**
 * Formato numerico de UNA columna, igual en todas sus filas (regla M4).
 * Un importe lleva su moneda en la clave (`...Usd`, `...Crc`) y toma los
 * decimales de esa moneda; el resto lleva dos decimales si alguna fila los usa.
 */
function numberFormat(key: string, report: ReportDto): string | null {
  const currency = key.endsWith('Usd') ? Currency.USD : key.endsWith('Crc') ? Currency.CRC : null;
  const digits = currency
    ? CURRENCY_DECIMALS[currency]
    : report.rows.some((row) => typeof row[key] === 'number' && !Number.isInteger(row[key]))
      ? 2
      : null;
  if (digits === null) return null;
  const number = digits > 0 ? `#,##0.${'0'.repeat(digits)}` : '#,##0';
  return currency ? `"${CURRENCY_SYMBOLS[currency]}"${number}` : number;
}

/** Ancho de columna aproximado al contenido, acotado para que no se desborde. */
function widthOf(values: string[]): number {
  const longest = values.reduce((max, v) => Math.max(max, v.length), 0);
  return Math.min(Math.max(longest + 2, 10), 50);
}

/** Serializa el reporte a un libro de Excel con una sola hoja. */
export async function renderReportXlsx(report: ReportDto): Promise<Uint8Array<ArrayBuffer>> {
  const workbook = new ExcelJS.Workbook();
  // El nombre de hoja admite 31 caracteres y no admite ciertos simbolos.
  const sheetName = REPORT_LABELS[report.kind].replace(/[\\/?*[\]:]/g, '').slice(0, 31);
  const ws = workbook.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });

  const header = ws.addRow(report.columns.map((c) => c.label));
  header.eachCell((cell) => {
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: COLOR.head } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.headFill } };
    cell.border = { bottom: { style: 'thin', color: { argb: COLOR.border } } };
    cell.alignment = { vertical: 'middle' };
  });

  const formats = report.columns.map((c) => numberFormat(c.key, report));

  for (const row of report.rows) {
    const added = ws.addRow(
      report.columns.map((c) => {
        const value = row[c.key] ?? null;
        return typeof value === 'string' && INSTANT.test(value) ? toLocalDate(value) : value;
      }),
    );
    added.eachCell((cell, col) => {
      cell.font = { name: FONT, size: 10 };
      if (cell.value instanceof Date) cell.numFmt = 'dd/mm/yyyy hh:mm';
      else if (typeof cell.value === 'number' && formats[col - 1]) cell.numFmt = formats[col - 1]!;
    });
  }

  report.columns.forEach((column, index) => {
    const values = report.rows.map((row) => {
      const value = row[column.key];
      return value === null || value === undefined
        ? ''
        : typeof value === 'string' && INSTANT.test(value)
          ? 'dd/mm/yyyy hh:mm'
          : String(value);
    });
    ws.getColumn(index + 1).width = widthOf([column.label, ...values]);
  });

  if (report.columns.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: report.columns.length } };
  }

  // Copia a un `Uint8Array` propio: es lo que acepta `c.body` de Hono.
  const data = new Uint8Array(await workbook.xlsx.writeBuffer());
  const out = new Uint8Array(data.byteLength);
  out.set(data);
  return out;
}
