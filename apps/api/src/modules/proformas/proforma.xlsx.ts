/**
 * Documento de la proforma en Excel (.xlsx), con el MISMO formato que el
 * documento imprimible (`proforma.render.ts`): logo, encabezado con numero y
 * fecha, datos del cliente, recuadro SINPE Movil, detalle de conceptos, tabla de
 * paquetes y las dos filas de total.
 *
 * No es el CSV con otra extension: el CSV es un archivo para que otra
 * herramienta lo lea; este es el documento para entregarlo o retocarlo en la
 * hoja de calculo. Por eso los importes son NUMEROS con el formato de su moneda
 * (se pueden sumar) y no texto ya formateado.
 *
 * Un borrador lleva la marca BORRADOR y sale sin numero, igual que en el HTML.
 */
import ExcelJS from 'exceljs';
import {
  CURRENCY_DECIMALS,
  CURRENCY_SYMBOLS,
  Currency,
  PROFORMA_STATUS_LABELS,
  ProformaStatus,
} from '@courier/shared';
import { BRAND_LOGO_DATA_URI } from '../../core/brand-logo';
import {
  SINPE_MOVIL,
  conceptSummary,
  day,
  extrasTotal,
  otherCurrency,
  rate,
  totalWeightKg,
} from './proforma.render';
import type { ProformaDocument } from './proforma.render';

/** Paleta del documento HTML (mismos colores que `STYLES`), en ARGB. */
const COLOR = {
  text: 'FF111827',
  muted: 'FF6B7280',
  head: 'FF374151',
  headFill: 'FFF9FAFB',
  border: 'FFE5E7EB',
  strong: 'FF111827',
  draft: 'FF92400E',
  draftBorder: 'FFB45309',
  sinpeFill: 'FFEFF6FF',
  sinpeTitle: 'FF1E3A8A',
  sinpeHolder: 'FF1E40AF',
  sinpePhone: 'FFDC2626',
} as const;

const FONT = 'Segoe UI';

/** Seis columnas, las de la tabla de paquetes; el resto del documento se acomoda en ellas. */
const COLUMNS = [16, 22, 20, 32, 10, 16];
const LAST_COL = COLUMNS.length;

/** Formato numerico de un importe: los decimales de SU moneda (regla M4). */
function moneyFormat(currency: Currency): string {
  const digits = CURRENCY_DECIMALS[currency];
  return digits > 0 ? `#,##0.${'0'.repeat(digits)}` : '#,##0';
}

function font(extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
  return { name: FONT, size: 10, color: { argb: COLOR.text }, ...extra };
}

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

const thin = (argb: string): Partial<ExcelJS.Border> => ({ style: 'thin', color: { argb } });

/** Escribe una celda (opcionalmente combinada hasta `toCol`) con su estilo. */
function put(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: ExcelJS.CellValue,
  style: Partial<ExcelJS.Style> = {},
  toCol = col,
): ExcelJS.Cell {
  if (toCol > col) ws.mergeCells(row, col, row, toCol);
  const cell = ws.getCell(row, col);
  cell.value = value;
  cell.font = font();
  Object.assign(cell, style);
  return cell;
}

/** Titulo de una tabla, como el `caption` del HTML. */
function caption(ws: ExcelJS.Worksheet, row: number, text: string): void {
  put(ws, row, 1, text.toUpperCase(), { font: font({ size: 9, color: { argb: COLOR.muted } }) }, LAST_COL);
}

/** Fila de cabecera de tabla: fondo gris claro, mayusculas, linea inferior. */
function headerRow(ws: ExcelJS.Worksheet, row: number, cells: Array<[number, number, string, boolean]>): void {
  for (const [from, to, text, numeric] of cells) {
    put(
      ws, row, from, text.toUpperCase(),
      {
        font: font({ size: 9, bold: true, color: { argb: COLOR.head } }),
        fill: fill(COLOR.headFill),
        alignment: { horizontal: numeric ? 'right' : 'left', vertical: 'middle', wrapText: true },
      },
      to,
    );
  }
  for (let c = 1; c <= LAST_COL; c++) {
    const cell = ws.getCell(row, c);
    cell.fill = fill(COLOR.headFill);
    cell.border = { bottom: thin(COLOR.border) };
  }
}

/** Linea inferior gris en toda la fila, como el `border-bottom` de las celdas del HTML. */
function rowBorder(ws: ExcelJS.Worksheet, row: number): void {
  for (let c = 1; c <= LAST_COL; c++) ws.getCell(row, c).border = { bottom: thin(COLOR.border) };
}

/**
 * Las dos filas de total: arriba la moneda del documento y debajo la otra con su
 * TC, de referencia (se omite si no hay tasa, igual que en el HTML).
 */
function totalRows(ws: ExcelJS.Worksheet, start: number, doc: ProformaDocument): number {
  const amount = (c: Currency) => (c === Currency.USD ? doc.totals.usd : doc.totals.crc);
  const label = (c: Currency) => (c === Currency.CRC ? 'TOTAL COLONES' : 'TOTAL USD');
  let row = start;

  put(ws, row, 1, label(doc.currency), { font: font({ bold: true }) }, LAST_COL - 1);
  put(ws, row, LAST_COL, amount(doc.currency), {
    font: font({ bold: true }),
    numFmt: moneyFormat(doc.currency),
    alignment: { horizontal: 'right' },
  });
  for (let c = 1; c <= LAST_COL; c++) ws.getCell(row, c).border = { top: { style: 'medium', color: { argb: COLOR.strong } } };
  row++;

  if (doc.exchangeRate !== null) {
    const other = otherCurrency(doc.currency);
    const muted = font({ bold: true, color: { argb: COLOR.head } });
    put(ws, row, 1, `${label(other)} (TC ${rate(doc.exchangeRate)})`, { font: muted }, LAST_COL - 1);
    put(ws, row, LAST_COL, amount(other), {
      font: muted,
      numFmt: moneyFormat(other),
      alignment: { horizontal: 'right' },
    });
    row++;
  }
  return row;
}

/** Nombre de hoja valido para Excel: sin `[]:*?/\`, max 31 caracteres y unico en el libro. */
function sheetName(doc: ProformaDocument, used: Set<string>): string {
  const base = (doc.number ? `Proforma ${doc.number}` : 'Borrador').replace(/[[\]:*?/\\]/g, '-').slice(0, 28);
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`.slice(0, 31);
  used.add(name.toLowerCase());
  return name;
}

/** Pinta UNA proforma en su hoja. */
function addSheet(wb: ExcelJS.Workbook, logoId: number, doc: ProformaDocument, name: string): void {
  const ws = wb.addWorksheet(name, {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9, // A4
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
    },
  });
  ws.columns = COLUMNS.map((width) => ({ width }));
  const { currency } = doc;
  const isDraft = doc.status === ProformaStatus.Borrador;

  // --- Encabezado: logo + marca a la izquierda, numero y fecha a la derecha.
  for (let r = 1; r <= 5; r++) ws.getRow(r).height = 18;
  ws.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 110, height: 92 } });
  put(ws, 2, 2, 'HS Global Services', { font: font({ size: 15, bold: true }) }, 3);
  put(ws, 3, 2, `Proforma · ${PROFORMA_STATUS_LABELS[doc.status]}`, { font: font({ size: 9, color: { argb: COLOR.muted } }) }, 3);

  const right: Partial<ExcelJS.Alignment> = { horizontal: 'right' };
  put(ws, 1, 4, doc.number ? 'PROFORMA N.º' : 'PROFORMA', {
    font: font({ size: 8, color: { argb: COLOR.muted } }),
    alignment: right,
  }, LAST_COL);
  put(ws, 2, 4, doc.number ?? 'Sin número', { font: font({ size: 14, bold: true }), alignment: right }, LAST_COL);
  put(ws, 3, 4, `Fecha: ${day(doc.issuedAt)}`, { alignment: right }, LAST_COL);
  if (doc.electronicInvoiceNumber) {
    put(ws, 4, 4, `FE: ${doc.electronicInvoiceNumber}`, { font: font({ bold: true }), alignment: right }, LAST_COL);
  }

  let row = 7;
  if (isDraft) {
    const dashed: Partial<ExcelJS.Border> = { style: 'mediumDashed', color: { argb: COLOR.draftBorder } };
    put(ws, row, 1, 'BORRADOR · VISTA PREVIA, NO ES UN DOCUMENTO EMITIDO', {
      font: font({ bold: true, color: { argb: COLOR.draft } }),
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: { top: dashed, bottom: dashed, left: dashed, right: dashed },
    }, LAST_COL);
    ws.getRow(row).height = 24;
    row += 2;
  }

  // --- Datos del cliente (izquierda) y recuadro SINPE Movil (derecha).
  const clientStart = row;
  put(ws, row++, 1, 'DATOS DEL CLIENTE', { font: font({ size: 9, color: { argb: COLOR.muted } }) }, 3);
  put(ws, row++, 1, doc.client.name, { font: font({ size: 12, bold: true }) }, 3);
  put(ws, row++, 1, `Cédula: ${doc.client.idNumber}`, {}, 3);
  if (doc.client.phone) put(ws, row++, 1, `Tel: ${doc.client.phone}`, {}, 3);
  put(ws, row++, 1, doc.client.address, { alignment: { wrapText: true, vertical: 'top' } }, 3);
  put(ws, row++, 1, doc.client.email, {}, 3);

  const sinpe = [
    { text: 'SINPE MÓVIL', f: font({ size: 13, bold: true, color: { argb: COLOR.sinpeTitle } }) },
    { text: SINPE_MOVIL.holder.toUpperCase(), f: font({ size: 12, color: { argb: COLOR.sinpeHolder } }) },
    { text: `Tel: ${SINPE_MOVIL.phone}`, f: font({ size: 13, bold: true, color: { argb: COLOR.sinpePhone } }) },
  ];
  const accent: Partial<ExcelJS.Border> = { style: 'thick', color: { argb: COLOR.sinpeTitle } };
  sinpe.forEach((line, i) => {
    const r = clientStart + 1 + i;
    put(ws, r, 4, line.text, {
      font: line.f,
      fill: fill(COLOR.sinpeFill),
      alignment: { indent: 1, vertical: 'middle' },
      border: { left: accent },
    }, LAST_COL);
    ws.getRow(r).height = 20;
  });
  row = Math.max(row, clientStart + 1 + sinpe.length) + 1;

  // --- Detalle de conceptos.
  caption(ws, row++, 'Detalle de conceptos');
  headerRow(ws, row++, [
    [1, 1, 'Cantidad', true],
    [2, 4, 'Concepto', false],
    [5, 5, 'Cod sis FE', false],
    [6, 6, `Monto (${currency})`, true],
  ]);
  for (const c of conceptSummary(doc)) {
    put(ws, row, 1, c.quantity, { alignment: right });
    put(ws, row, 2, c.label, {}, 4);
    put(ws, row, 5, c.electronicInvoiceCode ?? '-', c.electronicInvoiceCode ? {} : { font: font({ color: { argb: 'FF9CA3AF' } }) });
    put(ws, row, 6, c.amount, { numFmt: moneyFormat(currency), alignment: right });
    rowBorder(ws, row++);
  }
  row = totalRows(ws, row, doc) + 1;

  // --- Paquetes y tramites.
  caption(ws, row++, `Paquetes y trámites (${doc.items.length}) · montos en ${currency} (${CURRENCY_SYMBOLS[currency]})`);
  headerRow(ws, row++, [
    [1, 1, 'Trámite', false],
    [2, 2, 'Tracking Number', false],
    [3, 3, 'AWB / Guía', false],
    [4, 4, 'Descripción', false],
    [5, 5, 'Peso kg', true],
    [6, 6, 'Total', true],
  ]);
  const wrap: Partial<ExcelJS.Alignment> = { wrapText: true, vertical: 'top' };
  for (const item of doc.items) {
    put(ws, row, 1, item.code, { alignment: wrap });
    put(ws, row, 2, item.tracking, { alignment: wrap });
    put(ws, row, 3, item.awb, { alignment: wrap });
    put(ws, row, 4, item.description, { alignment: wrap });
    put(ws, row, 5, item.weightKg, { alignment: { horizontal: 'right', vertical: 'top' } });
    put(ws, row, 6, item.total, { numFmt: moneyFormat(currency), alignment: { horizontal: 'right', vertical: 'top' } });
    rowBorder(ws, row++);
  }
  const weight = totalWeightKg(doc);
  if (weight !== null) {
    put(ws, row, 1, 'Peso total', { font: font({ bold: true }) }, 4);
    put(ws, row, 5, weight, { font: font({ bold: true }), alignment: right });
    rowBorder(ws, row++);
  }
  if (doc.extras.length > 0) {
    put(ws, row, 1, 'Servicios de la proforma', {}, LAST_COL - 1);
    put(ws, row, LAST_COL, extrasTotal(doc), { numFmt: moneyFormat(currency), alignment: right });
    rowBorder(ws, row++);
  }
  row = totalRows(ws, row, doc) + 1;

  put(ws, row, 1, 'Documento proforma. No sustituye la factura electrónica.', {
    font: font({ size: 9, color: { argb: COLOR.muted } }),
  }, LAST_COL);

  ws.pageSetup.printArea = `A1:${ws.getColumn(LAST_COL).letter}${row}`;
}

function newWorkbook(): { wb: ExcelJS.Workbook; logoId: number } {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HS Global Services';
  wb.created = new Date();
  const logoId = wb.addImage({ base64: BRAND_LOGO_DATA_URI, extension: 'png' });
  return { wb, logoId };
}

/** Copia a un `Uint8Array` propio: es lo que acepta `c.body` de Hono. */
async function toBuffer(wb: ExcelJS.Workbook): Promise<Uint8Array<ArrayBuffer>> {
  const data = new Uint8Array(await wb.xlsx.writeBuffer());
  const out = new Uint8Array(data.byteLength);
  out.set(data);
  return out;
}

/** Libro de UNA proforma: una hoja con el documento. */
export async function renderProformaXlsx(doc: ProformaDocument): Promise<Uint8Array<ArrayBuffer>> {
  const { wb, logoId } = newWorkbook();
  addSheet(wb, logoId, doc, sheetName(doc, new Set()));
  return toBuffer(wb);
}

/**
 * LOTE en Excel: todas las proformas del filtro, una hoja por proforma. Si el
 * tope recorto el filtro, una primera hoja lo dice (misma regla que el lote HTML).
 */
export async function renderProformasXlsx(docs: readonly ProformaDocument[], total: number): Promise<Uint8Array<ArrayBuffer>> {
  const { wb, logoId } = newWorkbook();
  const omitted = total - docs.length;
  if (omitted > 0 || docs.length === 0) {
    const ws = wb.addWorksheet('Aviso', { views: [{ showGridLines: false }] });
    ws.getColumn(1).width = 100;
    const text =
      docs.length === 0
        ? 'No hay proformas con ese filtro.'
        : `Lote incompleto: este libro trae ${docs.length} de ${total} proformas del filtro. ` +
          `Filtra por estado, tipo o cliente para descargar las ${omitted} restantes.`;
    put(ws, 1, 1, text, { font: font({ bold: true }), alignment: { wrapText: true } });
  }
  const used = new Set<string>();
  for (const doc of docs) addSheet(wb, logoId, doc, sheetName(doc, used));
  return toBuffer(wb);
}
