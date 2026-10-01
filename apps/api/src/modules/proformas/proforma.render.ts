/**
 * Documento de la proforma: HTML imprimible (el PDF sale de "imprimir o guardar
 * como PDF" del navegador, decision P12) y CSV con el detalle por paquete.
 *
 * POR QUE HTML Y NO UN PDF GENERADO. Lo que se entrega es un DOCUMENTO que el
 * navegador ya sabe paginar e imprimir a PDF; generarlo en el servidor obligaria
 * a meter un navegador sin interfaz en la infraestructura para reproducir lo
 * mismo. Si algun dia hace falta, este modulo es el unico punto que cambia: el
 * modelo del documento (`ProformaDocument`) ya trae todos los datos.
 *
 * UN BORRADOR TAMBIEN SE IMPRIME (objetivo 9: vista previa antes de aprobar),
 * pero no se puede confundir con el documento emitido: lleva la marca BORRADOR
 * en cada hoja y no lleva numero. Una vista previa que se pareciera al documento
 * final seria un documento final sin numero.
 */
import {
  CURRENCY_DECIMALS,
  CURRENCY_SYMBOLS,
  Currency,
  FLOW_LABELS,
  PROFORMA_DELIVERY_STATUS_LABELS,
  PROFORMA_STATUS_LABELS,
  ProformaStatus,
  roundMoney,
} from '@courier/shared';
import type { ProformaListItem } from '@courier/shared';
import { BRAND_LOGO_DATA_URI } from '../../core/brand-logo';

/** Zona del negocio: todos los clientes son de Costa Rica (CLAUDE.md). */
const TIME_ZONE = 'America/Costa_Rica';

/** Cuenta SINPE Móvil donde el cliente paga la proforma. */
export const SINPE_MOVIL = { holder: 'Jennifer Sanchez', phone: '7019-6535' } as const;

/** Un concepto cobrado, ya en la moneda del documento. */
export interface DocumentLine {
  label: string;
  electronicInvoiceCode: string | null;
  amount: number;
}

/** Un paquete o tramite del documento, con su desglose en la moneda del documento. */
export interface DocumentItem {
  code: string;
  /** HAWB en Paqueteria, AWB/BL en el resto. */
  awb: string;
  tracking: string;
  description: string;
  /** Peso FACTURABLE (el que multiplica al flete), no el de bascula. */
  weightKg: number | null;
  freight: number;
  others: number;
  taxes: number;
  total: number;
  lines: DocumentLine[];
}

/** Todo lo que el documento imprime. Lo arma el servicio; aqui solo se pinta. */
export interface ProformaDocument {
  /** Numero formateado; null en un borrador que nunca se aprobo. */
  number: string | null;
  status: ProformaStatus;
  currency: Currency;
  /** Tasa del documento (la congelada, o la vigente en un borrador). */
  exchangeRate: number | null;
  /** Fecha del documento: la de aprobacion, o la de hoy en un borrador. UTC ISO. */
  issuedAt: string;
  electronicInvoiceNumber: string | null;
  client: {
    name: string;
    idNumber: string;
    phone: string | null;
    address: string;
    email: string;
  };
  items: DocumentItem[];
  /** Servicios adicionales cargados a la proforma entera. */
  extras: DocumentLine[];
  totals: { usd: number; crc: number };
}

/**
 * Escapa texto para incrustarlo en HTML. TODO dato que venga de la BD pasa por
 * aqui: nombres, descripciones y notas son texto libre que alguien digito.
 */
function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Instante UTC -> fecha en hora de Costa Rica. */
export function day(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CR', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** Importe con los decimales de SU moneda (regla M4: `CURRENCY_DECIMALS`, punto unico). */
function money(amount: number, currency: Currency): string {
  const digits = CURRENCY_DECIMALS[currency];
  return amount.toLocaleString('es-CR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** La tasa no es un importe: se imprime con dos decimales, sin redondear a colon entero. */
export function rate(crcPerUsd: number): string {
  return crcPerUsd.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Subtotal de los servicios de la proforma, redondeado por la politica unica (M4). */
export function extrasTotal(doc: ProformaDocument): number {
  return roundMoney(
    doc.extras.reduce((sum, line) => sum + line.amount, 0),
    doc.currency,
  );
}

/**
 * Peso total del documento: la suma del peso facturable de cada paquete. No es un
 * monto, asi que se deja con tres decimales de bascula. `null` si ninguno tiene peso.
 */
export function totalWeightKg(doc: ProformaDocument): number | null {
  const weights = doc.items.map((item) => item.weightKg).filter((w): w is number => w !== null);
  return weights.length > 0 ? Math.round(weights.reduce((a, b) => a + b, 0) * 1000) / 1000 : null;
}

export function otherCurrency(currency: Currency): Currency {
  return currency === Currency.USD ? Currency.CRC : Currency.USD;
}

/**
 * Las dos filas de total: arriba la MONEDA DEL DOCUMENTO (en la que se cobra) y
 * debajo la otra con su TC, de referencia. Sin tasa (borrador sin tasa fijada)
 * se omite la referencia en vez de imprimir una conversion inventada.
 */
function totalRows(doc: ProformaDocument, colspan: number): string {
  const amount = (c: Currency) => (c === Currency.USD ? doc.totals.usd : doc.totals.crc);
  const label = (c: Currency) => (c === Currency.CRC ? 'TOTAL COLONES' : 'TOTAL USD');
  const other = otherCurrency(doc.currency);
  const reference =
    doc.exchangeRate === null
      ? ''
      : `<tr class="crc">
      <td colspan="${colspan}">${label(other)} (TC ${rate(doc.exchangeRate)})</td>
      <td class="num">${money(amount(other), other)}</td>
    </tr>`;

  return `<tr>
      <td colspan="${colspan}">${label(doc.currency)}</td>
      <td class="num">${money(amount(doc.currency), doc.currency)}</td>
    </tr>${reference}`;
}

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #f3f4f6; color: #111827;
    font: 13px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  .sheet {
    position: relative;
    width: 210mm; min-height: 297mm; margin: 12px auto; padding: 16mm 14mm;
    background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.15);
  }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 20px; font-weight: 700; letter-spacing: .5px; }
  .brand img { width: 96px; height: auto; flex: none; }
  .brand small { display: block; font-size: 11px; font-weight: 400; color: #6b7280; letter-spacing: 0; }
  .head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  .meta { text-align: right; font-size: 12px; }
  .meta .label { font-size: 10px; letter-spacing: 1px; color: #6b7280; text-transform: uppercase; }
  .meta .num { font-size: 18px; font-weight: 700; letter-spacing: .5px; }
  .draft-mark {
    margin: 14px 0 0; padding: 8px 12px; border: 2px dashed #b45309; color: #92400e;
    font-weight: 700; letter-spacing: 2px; text-align: center; text-transform: uppercase;
  }
  .client-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin: 22px 0 18px; }
  .who { min-width: 0; }
  tr.weight td { font-weight: 700; }
  .sinpe {
    flex: none; min-width: 210px; padding: 10px 16px; border-left: 4px solid #1e3a8a;
    background: #eff6ff; border-radius: 4px;
  }
  .sinpe .title { font-size: 16px; font-weight: 700; letter-spacing: .5px; color: #1e3a8a; text-transform: uppercase; }
  .sinpe .holder { font-size: 15px; color: #1e40af; text-transform: uppercase; }
  .sinpe .phone { font-size: 16px; font-weight: 700; color: #dc2626; }
  .who h2 { margin: 0 0 6px; font-size: 11px; letter-spacing: 1px; color: #6b7280; text-transform: uppercase; }
  .who .name { font-weight: 600; font-size: 15px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  caption {
    caption-side: top; text-align: left; padding: 0 0 6px;
    font-size: 11px; letter-spacing: 1px; color: #6b7280; text-transform: uppercase;
  }
  th, td { padding: 7px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; }
  th { font-size: 11px; letter-spacing: .5px; text-transform: uppercase; color: #374151; background: #f9fafb; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.wide { table-layout: fixed; font-size: 11px; }
  table.wide th, table.wide td { padding: 6px 5px; overflow-wrap: anywhere; }
  table.wide th { white-space: normal; }
  tfoot td { font-weight: 700; border-top: 2px solid #111827; border-bottom: none; }
  tfoot tr.crc td { font-weight: 600; color: #374151; border-top: none; }
  tr.group td { background: #f9fafb; font-weight: 600; }
  .empty { color: #9ca3af; }
  .foot { margin-top: 26px; font-size: 11px; color: #6b7280; }
  @media print {
    body { background: #fff; }
    .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    .sheet + .sheet { page-break-before: always; }
  }
`;

/**
 * Tabla de paquetes: una fila por paquete con su peso y su total. El desglose por
 * concepto ya lo da el detalle de conceptos (arriba), asi que aqui no se repite
 * flete / otros / impuestos por paquete.
 */
function itemsTable(doc: ProformaDocument): string {
  const { currency } = doc;
  const rows = doc.items
    .map(
      (item) => `<tr>
        <td>${esc(item.code)}</td>
        <td>${esc(item.tracking)}</td>
        <td>${esc(item.awb)}</td>
        <td>${esc(item.description)}</td>
        <td class="num">${item.weightKg ?? ''}</td>
        <td class="num">${money(item.total, currency)}</td>
      </tr>`,
    )
    .join('');

  const weight = totalWeightKg(doc);
  const weightRow =
    weight !== null
      ? `<tr class="weight">
        <td colspan="4">Peso total</td>
        <td class="num">${weight}</td>
        <td></td>
      </tr>`
      : '';

  const extrasRow =
    doc.extras.length > 0
      ? `<tr>
        <td colspan="5">Servicios de la proforma</td>
        <td class="num">${money(extrasTotal(doc), currency)}</td>
      </tr>`
      : '';

  return `<table class="wide">
    <caption>
      Paquetes y trámites (${doc.items.length}) · montos en ${esc(currency)} (${esc(CURRENCY_SYMBOLS[currency])})
    </caption>
    <colgroup>
      <col style="width:15%"><col style="width:19%"><col style="width:16%"><col style="width:28%">
      <col style="width:9%"><col style="width:13%">
    </colgroup>
    <thead><tr>
      <th>Trámite</th><th>Tracking Number</th><th>AWB / Guía</th><th>Descripción</th><th class="num">Peso kg</th>
      <th class="num">Total</th>
    </tr></thead>
    <tbody>${rows}${weightRow}${extrasRow}</tbody>
    <tfoot>${totalRows(doc, 5)}</tfoot>
  </table>`;
}

/** Un concepto del detalle: todas las lineas iguales del documento, sumadas. */
export interface ConceptSummary {
  label: string;
  electronicInvoiceCode: string | null;
  quantity: number;
  amount: number;
}

/**
 * Agrupa los conceptos de TODO el documento (paquetes y servicios de la
 * proforma) por concepto + codigo FE: seis paquetes con flete dan UNA linea de
 * Flete con la suma y cantidad 6. Conserva el orden de primera aparicion.
 */
export function conceptSummary(doc: ProformaDocument): ConceptSummary[] {
  const groups = new Map<string, ConceptSummary>();
  const all = [...doc.items.flatMap((item) => item.lines), ...doc.extras];
  for (const line of all) {
    const key = `${line.label}|${line.electronicInvoiceCode ?? ''}`;
    const group = groups.get(key);
    if (group) {
      group.quantity += 1;
      group.amount += line.amount;
    } else {
      groups.set(key, {
        label: line.label,
        electronicInvoiceCode: line.electronicInvoiceCode,
        quantity: 1,
        amount: line.amount,
      });
    }
  }
  return [...groups.values()].map((g) => ({ ...g, amount: roundMoney(g.amount, doc.currency) }));
}

/** Detalle de conceptos: una linea por concepto con su cantidad y su suma, y el total. */
function linesTable(doc: ProformaDocument): string {
  const rows = conceptSummary(doc)
    .map(
      (c) => `<tr>
      <td class="num">${c.quantity}</td>
      <td>${esc(c.label)}</td>
      <td>${c.electronicInvoiceCode ? esc(c.electronicInvoiceCode) : '<span class="empty">-</span>'}</td>
      <td class="num">${money(c.amount, doc.currency)}</td>
    </tr>`,
    )
    .join('');

  return `<table>
    <caption>Detalle de conceptos</caption>
    <thead><tr>
      <th class="num">Cantidad</th><th>Concepto</th><th>Cod sis FE</th>
      <th class="num">Monto (${esc(doc.currency)})</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>${totalRows(doc, 3)}</tfoot>
  </table>`;
}

/** Una proforma, como una hoja del documento. */
function sheet(doc: ProformaDocument): string {
  const isDraft = doc.status === ProformaStatus.Borrador;
  const number = doc.number
    ? `<div class="label">Proforma n.º</div><div class="num">${esc(doc.number)}</div>`
    : '<div class="label">Proforma</div><div class="num">Sin número</div>';
  const fe = doc.electronicInvoiceNumber
    ? `<div>FE: <strong>${esc(doc.electronicInvoiceNumber)}</strong></div>`
    : '';
  const draftMark = isDraft
    ? `<div class="draft-mark">Borrador · vista previa, no es un documento emitido</div>`
    : '';

  return `<section class="sheet">
    <div class="head">
      <div class="brand">
        <img src="${BRAND_LOGO_DATA_URI}" alt="HS Global Services">
        <div>HS Global Services<small>Proforma · ${esc(PROFORMA_STATUS_LABELS[doc.status])}</small></div>
      </div>
      <div class="meta">
        ${number}
        <div>Fecha: ${day(doc.issuedAt)}</div>
        ${fe}
      </div>
    </div>
    ${draftMark}

    <div class="client-row">
      <div class="who">
        <h2>Datos del cliente</h2>
        <div class="name">${esc(doc.client.name)}</div>
        <div>Cédula: ${esc(doc.client.idNumber)}</div>
        ${doc.client.phone ? `<div>Tel: ${esc(doc.client.phone)}</div>` : ''}
        <div>${esc(doc.client.address)}</div>
        <div>${esc(doc.client.email)}</div>
      </div>
      <div class="sinpe">
        <div class="title">SINPE Móvil</div>
        <div class="holder">${esc(SINPE_MOVIL.holder)}</div>
        <div class="phone">Tel: ${esc(SINPE_MOVIL.phone)}</div>
      </div>
    </div>

    ${linesTable(doc)}
    ${itemsTable(doc)}

    <div class="foot">Documento proforma. No sustituye la factura electrónica.</div>
  </section>`;
}

/** Documento HTML completo de UNA proforma. */
export function renderProforma(doc: ProformaDocument): string {
  const title = doc.number ? `Proforma ${doc.number}` : 'Proforma (borrador)';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${sheet(doc)}
</body>
</html>`;
}

/**
 * LOTE de documentos: todas las proformas del filtro en un solo HTML, una por
 * pagina, para imprimirlas o guardarlas como PDF de una vez. Si el tope recorto
 * el filtro, la primera hoja lo dice: un lote que calla lo que dejo fuera se lee
 * como si fuera todo.
 */
export function renderProformas(docs: readonly ProformaDocument[], total: number): string {
  const omitted = total - docs.length;
  const notice =
    omitted > 0
      ? `<section class="sheet"><h1>Lote incompleto</h1><p>Este documento trae ${docs.length} de ${total} proformas del filtro. Filtra por estado, tipo o cliente para imprimir las ${omitted} restantes.</p></section>`
      : '';
  const body =
    docs.length > 0
      ? docs.map((d) => sheet(d)).join('\n')
      : '<section class="sheet"><p>No hay proformas con ese filtro.</p></section>';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proformas (${docs.length})</title>
<style>${STYLES}</style>
</head>
<body>
${notice}
${body}
</body>
</html>`;
}

/** Instante UTC -> fecha en hora de Costa Rica, o vacio. Para el CSV. */
function csvDay(iso: string | null): string | null {
  return iso ? day(iso) : null;
}

/**
 * REPORTE del listado en CSV: una fila por proforma, con los filtros de la
 * bandeja. Mismas convenciones que el CSV del documento (BOM, punto decimal, sin
 * separador de miles). El total va en la moneda de la proforma y, aparte, en las
 * dos monedas para poder sumar columnas sin mezclar.
 */
export function renderProformaListCsv(items: readonly ProformaListItem[], total: number): string {
  const header = [
    'Proforma', 'Estado', 'Entrega', 'Tipo', 'Cliente', 'Casillero', 'Trámites',
    'Moneda', 'Total', 'Total USD', 'Total CRC', 'Factura electrónica',
    'Creada', 'Aprobada', 'Pagada',
  ];
  const rows = items.map((i) => [
    i.number,
    PROFORMA_STATUS_LABELS[i.status],
    i.status === ProformaStatus.Borrador ? null : PROFORMA_DELIVERY_STATUS_LABELS[i.deliveryStatus],
    FLOW_LABELS[i.flow],
    i.client.name,
    i.client.code,
    i.shipmentCount,
    i.currency,
    (i.currency === Currency.USD ? i.totals.usd : i.totals.crc).toFixed(CURRENCY_DECIMALS[i.currency]),
    i.totals.usd.toFixed(CURRENCY_DECIMALS[Currency.USD]),
    i.totals.crc.toFixed(CURRENCY_DECIMALS[Currency.CRC]),
    i.electronicInvoiceNumber,
    csvDay(i.createdAt),
    csvDay(i.approvedAt),
    csvDay(i.paidAt),
  ]);
  const lines = [header, ...rows].map((r) => r.map((v) => csvCell(v as string | number | null)).join(','));
  if (total > items.length) {
    lines.push(csvCell(`Faltan ${total - items.length} proformas del filtro: el reporte trae las ${items.length} más recientes.`));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** Una celda CSV: comillas dobles escapadas y todo entre comillas. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * CSV con el detalle por paquete (objetivo 12). Una fila por paquete y, si hay
 * servicios de la proforma, una fila mas para ellos: sin esa fila la suma de la
 * columna Total no daria el total del documento.
 *
 * Los importes van SIN separador de miles y con punto decimal: es un archivo
 * para que otra herramienta lo lea, no para leerlo a ojo. El BOM delante es lo
 * que hace que Excel lo abra en UTF-8 y no destroce las tildes.
 */
export function renderProformaCsv(doc: ProformaDocument): string {
  const digits = CURRENCY_DECIMALS[doc.currency];
  const amount = (n: number) => n.toFixed(digits);
  const header = [
    'Proforma', 'Estado', 'Cliente', 'Trámite', 'AWB / Guía', 'Tracking', 'Descripción',
    'Peso kg', 'Flete', 'Otros / Permisos', 'Impuestos', 'Total', 'Moneda',
  ];
  const common = [doc.number, PROFORMA_STATUS_LABELS[doc.status], doc.client.name];
  const rows = doc.items.map((item) => [
    ...common,
    item.code,
    item.awb,
    item.tracking,
    item.description,
    item.weightKg,
    amount(item.freight),
    amount(item.others),
    amount(item.taxes),
    amount(item.total),
    doc.currency,
  ]);
  if (doc.extras.length > 0) {
    const subtotal = extrasTotal(doc);
    rows.push([
      ...common, '', '', '', 'Servicios de la proforma', null, '', amount(subtotal), '', amount(subtotal), doc.currency,
    ]);
  }
  const lines = [header, ...rows].map((row) => row.map((cell) => csvCell(cell ?? null)).join(','));
  return `﻿${lines.join('\r\n')}`;
}
