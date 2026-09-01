/**
 * Render de la proforma a HTML imprimible.
 *
 * POR QUE HTML Y NO XLSX. La plantilla de referencia es una hoja de calculo, pero
 * lo que se entrega es un DOCUMENTO: nadie recalcula una proforma, se lee, se
 * imprime o se manda. Generar xlsx obligaria a meter una libreria de Office en la
 * API para reproducir un formato que el navegador ya sabe paginar e imprimir a
 * PDF. Si algun dia hace falta el .xlsx literal, este modulo es el unico punto que
 * cambia: el DTO ya tiene todos los datos.
 *
 * EL LOTE ES UN SOLO DOCUMENTO, NO UN ZIP. "Bajar todas las proformas listas" se
 * resuelve con una pagina por proforma y un salto de pagina entre ellas: se
 * imprime de una vez y sale un PDF con todas. Un zip de archivos sueltos exigiria
 * una dependencia mas y dejaria al usuario abriendo cincuenta ventanas.
 */
import {
  CURRENCY_DECIMALS,
  CURRENCY_SYMBOLS,
  Currency,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PaymentStatus,
} from '@courier/shared';
import type { ConsolidatedProformaDto, ProformaDto } from '@courier/shared';

/** Zona del negocio: todos los clientes son de Costa Rica (CLAUDE.md). */
const TIME_ZONE = 'America/Costa_Rica';

/**
 * Escapa texto para incrustarlo en HTML. TODO dato que venga de la BD pasa por
 * aqui: nombres, descripciones y notas son texto libre que alguien digito, y un
 * `<` suelto en una descripcion romperia el documento (o algo peor).
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

/** Instante UTC -> fecha en hora de Costa Rica. Vacio si no hay fecha. */
function day(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-CR', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Importe con separadores, con los decimales de SU moneda: los toma de
 * `CURRENCY_DECIMALS` y no de un ternario escrito aqui (regla M4, punto unico de
 * la politica de redondeo de presentacion).
 */
function money(amount: number, currency: Currency): string {
  const digits = CURRENCY_DECIMALS[currency];
  return amount.toLocaleString('es-CR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * La TASA de la esquina ("TC"). No pasa por `money`: una tasa no es un importe en
 * colones, y redondearla a colon entero imprimia 513 donde la factura uso 512,75,
 * con lo que el lector no podia reproducir la conversion que tiene delante.
 */
function rate(crcPerUsd: number): string {
  return crcPerUsd.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** La otra moneda del negocio: la que va de referencia debajo del total. */
function otherCurrency(currency: Currency): Currency {
  return currency === Currency.USD ? Currency.CRC : Currency.USD;
}

/**
 * Las dos filas de total del pie de una tabla: arriba la MONEDA DEL DOCUMENTO (en
 * la que se tramito y se cobra) y debajo la otra con su TC, de referencia.
 *
 * Una sola funcion para las dos maquetas porque el ORDEN es la correccion: si la
 * proforma suelta y la consolidada eligieran cada una cual va primero, el mismo
 * cliente recibiria dos documentos que destacan la cifra en monedas distintas.
 */
function totalRows(
  currency: Currency,
  totals: { totalUsd: number; totalCrc: number },
  exchangeRate: number,
  colspan: number,
): string {
  const amount = (c: Currency) => (c === Currency.USD ? totals.totalUsd : totals.totalCrc);
  const label = (c: Currency) => (c === Currency.CRC ? 'TOTAL COLONES' : 'TOTAL USD');
  const other = otherCurrency(currency);

  return `<tr>
      <td colspan="${colspan}">${label(currency)}</td>
      <td class="num">${money(amount(currency), currency)}</td>
    </tr>
    <tr class="crc">
      <td colspan="${colspan}">${label(other)} (TC ${rate(exchangeRate)})</td>
      <td class="num">${money(amount(other), other)}</td>
    </tr>`;
}

/** Hoja de estilos del documento. Una sola vez aunque el lote traiga cincuenta. */
const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #f3f4f6; color: #111827;
    font: 13px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  .sheet {
    width: 210mm; min-height: 297mm; margin: 12px auto; padding: 16mm 14mm;
    background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.15);
  }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: .5px; }
  .brand small { display: block; font-size: 11px; font-weight: 400; color: #6b7280; letter-spacing: 0; }
  .head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  .meta { text-align: right; font-size: 12px; }
  .meta .num { font-size: 18px; font-weight: 700; }
  .who { margin: 22px 0 18px; }
  .who h2 { margin: 0 0 6px; font-size: 11px; letter-spacing: 1px; color: #6b7280; text-transform: uppercase; }
  .who div { font-size: 13px; }
  .who .name { font-weight: 600; font-size: 15px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  caption {
    caption-side: top; text-align: left; padding: 0 0 6px;
    font-size: 11px; letter-spacing: 1px; color: #6b7280; text-transform: uppercase;
  }
  th, td { padding: 7px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; }
  th { font-size: 11px; letter-spacing: .5px; text-transform: uppercase; color: #374151; background: #f9fafb; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tfoot td { font-weight: 700; border-top: 2px solid #111827; border-bottom: none; }
  tfoot tr.crc td { font-weight: 600; color: #374151; border-top: none; }
  .empty { color: #9ca3af; }
  .foot { margin-top: 26px; font-size: 11px; color: #6b7280; }
  /* Bloque del cobro agrupado: lo pagado va destacado porque es EL dato del documento. */
  .paid {
    display: flex; justify-content: space-between; gap: 16px; align-items: baseline;
    margin: 4px 0 18px; padding: 10px 12px; background: #f9fafb; border: 1px solid #e5e7eb;
  }
  .paid .label { font-size: 11px; letter-spacing: 1px; color: #6b7280; text-transform: uppercase; }
  .paid .amount { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .paid .pending { color: #92400e; }
  @media print {
    body { background: #fff; }
    .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    /* Una proforma por pagina; la ultima no arrastra una hoja en blanco. */
    .sheet + .sheet { page-break-before: always; }
  }
`;

/** Bloque de conceptos: lo que se cobra, con su codigo de factura electronica. */
function linesTable(proforma: ProformaDto): string {
  const { currency } = proforma;
  const rows = proforma.lines
    .map(
      (line) => `<tr>
        <td class="num">${line.quantity}</td>
        <td>${esc(line.label)}</td>
        <td>${line.electronicInvoiceCode ? esc(line.electronicInvoiceCode) : '<span class="empty">—</span>'}</td>
        <td class="num">${money(line.amount, currency)}</td>
      </tr>`,
    )
    .join('');

  return `<table>
    <caption>Detalle de la proforma</caption>
    <thead><tr>
      <th class="num">Cantidad</th><th>Concepto</th><th>Cod sis FE</th>
      <th class="num">Monto (${esc(currency)})</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      ${totalRows(currency, proforma, proforma.exchangeRate, 3)}
    </tfoot>
  </table>`;
}

/** Bloque "FACTURACION BOLETA ENTREGA": a que envio corresponde esta factura. */
function detailTable(proforma: ProformaDto): string {
  const d = proforma.detail;
  const { currency } = proforma;
  return `<table>
    <caption>
      Facturación boleta entrega — referencia ${esc(proforma.number)} ·
      montos en ${esc(currency)} (${esc(CURRENCY_SYMBOLS[currency])})
    </caption>
    <thead><tr>
      <th>AWB</th><th>Descripción</th><th class="num">Peso</th><th>Tracking</th>
      <th class="num">Flete</th><th class="num">Otros / Permisos</th><th class="num">Impuestos</th>
      <th class="num">Total</th><th>Entregado</th>
    </tr></thead>
    <tbody><tr>
      <td>${esc(d.awb)}</td>
      <td>${esc(d.description)}</td>
      <td class="num">${d.weightKg ?? ''}</td>
      <td>${esc(d.tracking)}</td>
      <td class="num">${money(d.freight, currency)}</td>
      <td class="num">${money(d.others, currency)}</td>
      <td class="num">${money(d.taxes, currency)}</td>
      <td class="num">${money(d.total, currency)}</td>
      <td>${d.deliveredAt ? day(d.deliveredAt) : '<span class="empty">Pendiente</span>'}</td>
    </tr></tbody>
  </table>`;
}

/** Una proforma, como una hoja del documento. */
function sheet(proforma: ProformaDto): string {
  const fe = proforma.electronicInvoiceNumber
    ? `<div>FE: <strong>${esc(proforma.electronicInvoiceNumber)}</strong></div>`
    : '';

  return `<section class="sheet">
    <div class="head">
      <div class="brand">HS Global Services<small>Proforma</small></div>
      <div class="meta">
        <div class="num">${esc(proforma.number)}</div>
        <div>Fecha: ${day(proforma.issuedAt)}</div>
        ${fe}
      </div>
    </div>

    <div class="who">
      <h2>Datos del cliente</h2>
      <div class="name">${esc(proforma.client.name)}</div>
      <div>Cédula: ${esc(proforma.client.idNumber)}</div>
      ${proforma.client.phone ? `<div>Tel: ${esc(proforma.client.phone)}</div>` : ''}
      <div>${esc(proforma.client.address)}</div>
      <div>${esc(proforma.client.email)}</div>
    </div>

    ${linesTable(proforma)}
    ${detailTable(proforma)}

    <div class="foot">
      Documento proforma. No sustituye la factura electrónica.
    </div>
  </section>`;
}

/**
 * Documento completo. Una proforma o cincuenta: la unica diferencia es cuantas
 * hojas lleva, y el salto de pagina lo pone el CSS.
 *
 * `omitted` avisa cuando el lote se recorto por el tope. Va impreso y no solo en
 * un log: un documento que dice "todas las proformas listas" y trae 200 de 340 es
 * exactamente el silencio que hace que alguien de por facturado lo que no lo esta.
 */
export function renderProformas(proformas: readonly ProformaDto[], omitted = 0): string {
  const title =
    proformas.length === 1 ? `Proforma ${proformas[0]!.number}` : `Proformas (${proformas.length})`;

  const notice =
    omitted > 0
      ? `<section class="sheet"><div class="foot">
           Se omitieron ${omitted} proformas por el límite de descarga. Acota el filtro y vuelve a bajarlas.
         </div></section>`
      : '';

  const body = proformas.length > 0
    ? proformas.map(sheet).join('\n')
    : '<section class="sheet"><div class="foot">No hay proformas listas para ese filtro.</div></section>';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
${notice}
</body>
</html>`;
}


// ---------------------------------------------------------------------------
// Proforma CONSOLIDADA
// ---------------------------------------------------------------------------
//
// Reusa la MISMA hoja de estilos y la misma estructura de hoja que la proforma
// suelta: es el mismo documento del mismo negocio, solo que la unidad es el cobro
// y no el tramite. Dos maquetas distintas para lo mismo habrian empezado a
// separarse en la primera correccion de formato.

/** Bloque de paquetes: una fila por paquete del cobro, con su desglose. */
function consolidatedItemsTable(proforma: ConsolidatedProformaDto): string {
  const { currency } = proforma;
  const rows = proforma.items
    .map(
      (item) => `<tr>
        <td>${esc(item.code)}</td>
        <td>${esc(item.description)}</td>
        <td class="num">${item.weightKg ?? ''}</td>
        <td>${esc(item.tracking)}</td>
        <td class="num">${money(item.freight, currency)}</td>
        <td class="num">${money(item.others, currency)}</td>
        <td class="num">${money(item.taxes, currency)}</td>
        <td class="num">${money(item.total, currency)}</td>
      </tr>`,
    )
    .join('');

  return `<table>
    <caption>
      Paquetes consolidados (${proforma.items.length}) ·
      montos en ${esc(currency)} (${esc(CURRENCY_SYMBOLS[currency])})
    </caption>
    <thead><tr>
      <th>Trámite</th><th>Descripción</th><th class="num">Peso kg</th><th>Tracking</th>
      <th class="num">Flete</th><th class="num">Otros / Permisos</th><th class="num">Impuestos</th>
      <th class="num">Total</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      ${totalRows(currency, proforma, proforma.exchangeRate, 7)}
    </tfoot>
  </table>`;
}

/**
 * Conceptos cobrados, paquete por paquete. Es el mismo bloque de la proforma
 * suelta repetido: el cliente tiene que poder ver de que se compone cada total,
 * y con varios paquetes en un solo cobro el desglose plano no dice de cual es
 * cada linea.
 */
function consolidatedLinesTable(proforma: ConsolidatedProformaDto): string {
  const rows = proforma.items
    .flatMap((item) =>
      item.lines.map(
        (line, index) => `<tr>
          <td>${index === 0 ? esc(item.code) : ''}</td>
          <td class="num">${line.quantity}</td>
          <td>${esc(line.label)}</td>
          <td>${line.electronicInvoiceCode ? esc(line.electronicInvoiceCode) : '<span class="empty">—</span>'}</td>
          <td class="num">${money(line.amount, proforma.currency)}</td>
        </tr>`,
      ),
    )
    .join('');

  return `<table>
    <caption>Conceptos cobrados</caption>
    <thead><tr>
      <th>Trámite</th><th class="num">Cantidad</th><th>Concepto</th><th>Cod sis FE</th>
      <th class="num">Monto (${esc(proforma.currency)})</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Lo PAGADO. Va destacado y con su situacion: el requisito pide que el documento
 * diga el monto total pagado, y un cobro en validacion todavia no lo es. Anunciar
 * "pagado" sobre un deposito sin validar es la unica forma de que este documento
 * mienta.
 */
function paidBlock(proforma: ConsolidatedProformaDto): string {
  const confirmed = proforma.paidStatus === PaymentStatus.Confirmado;
  const label = confirmed ? 'Total pagado' : 'Total del cobro';
  const when = proforma.paidAt ? ` · ${day(proforma.paidAt)}` : '';

  return `<div class="paid">
    <div>
      <div class="label">${label}</div>
      <div>${esc(PAYMENT_METHOD_LABELS[proforma.method])}${when}</div>
    </div>
    <div class="amount${confirmed ? '' : ' pending'}">
      ${money(proforma.paidAmount, proforma.currency)} ${esc(proforma.currency)}
      ${confirmed ? '' : `<div class="label">${esc(PAYMENT_STATUS_LABELS[proforma.paidStatus])}</div>`}
    </div>
  </div>`;
}

/** Una proforma consolidada, como una hoja del documento. */
function consolidatedSheet(proforma: ConsolidatedProformaDto): string {
  return `<section class="sheet">
    <div class="head">
      <div class="brand">HS Global Services<small>Proforma consolidada</small></div>
      <div class="meta">
        <div class="num">${esc(proforma.number)}</div>
        <div>Fecha: ${day(proforma.issuedAt)}</div>
        <div>Tarifa: ${esc(proforma.rateName)}</div>
      </div>
    </div>

    <div class="who">
      <h2>Datos del cliente</h2>
      <div class="name">${esc(proforma.client.name)}</div>
      <div>Cédula: ${esc(proforma.client.idNumber)}</div>
      ${proforma.client.phone ? `<div>Tel: ${esc(proforma.client.phone)}</div>` : ''}
      <div>${esc(proforma.client.address)}</div>
      <div>${esc(proforma.client.email)}</div>
    </div>

    ${paidBlock(proforma)}
    ${consolidatedItemsTable(proforma)}
    ${consolidatedLinesTable(proforma)}

    <div class="foot">
      Documento proforma de cobro consolidado. Agrupa ${proforma.items.length} paquetes
      en una sola factura. No sustituye la factura electrónica.
    </div>
  </section>`;
}

/**
 * Documento de proformas consolidadas. Mismo contrato que `renderProformas`: una
 * o cincuenta, el salto de pagina lo pone el CSS, y `omitted` avisa impreso
 * cuando el lote se recorto.
 */
export function renderConsolidatedProformas(
  proformas: readonly ConsolidatedProformaDto[],
  omitted = 0,
): string {
  const title =
    proformas.length === 1
      ? `Proforma consolidada ${proformas[0]!.number}`
      : `Proformas consolidadas (${proformas.length})`;

  const notice =
    omitted > 0
      ? `<section class="sheet"><div class="foot">
           Se omitieron ${omitted} proformas por el límite de descarga. Acota el filtro y vuelve a bajarlas.
         </div></section>`
      : '';

  const body =
    proformas.length > 0
      ? proformas.map(consolidatedSheet).join('\n')
      : '<section class="sheet"><div class="foot">No hay cobros consolidados para ese filtro.</div></section>';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
${notice}
</body>
</html>`;
}
