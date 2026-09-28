/**
 * Hoja de ruta del mensajero, en HTML imprimible.
 *
 * POR QUE HTML Y NO UN PDF GENERADO EN EL SERVIDOR. El mismo criterio de las
 * proformas (`proformas/proforma.render.ts`): lo que se entrega es un DOCUMENTO
 * que se imprime o se guarda, y el navegador ya sabe paginarlo e imprimirlo a
 * PDF. Meter una libreria de PDF en la API para reproducir lo que hace el
 * "Guardar como PDF" del navegador seria una dependencia nueva a cambio de nada.
 * Si algun dia hace falta el PDF binario (mandarlo por correo, archivarlo), este
 * modulo es el unico punto que cambia: el documento ya viene armado.
 *
 * EL PAPEL ES PARA LA CALLE. La pantalla de Entregas es la version interactiva y
 * esta es la de bolsillo: va agrupada por ruta y, dentro, por proforma (una
 * parada por proforma, con una sola firma), en el mismo orden en que se
 * recorre, y lleva una columna en blanco para firmar. Por eso incluye direccion
 * y telefono completos, y por eso el saldo va impreso: el mensajero tiene que
 * saber antes de tocar el timbre si va a cobrar.
 */
import {
  COLLECTION_STATUS_LABELS,
  CollectionStatus,
  SHIPMENT_TYPE_LABELS,
  findCanton,
  findDistrict,
  findProvince,
  formatMoney,
  usesPackageFields,
} from '@courier/shared';
import type { Currency, ShipmentType } from '@courier/shared';

/** Zona del negocio: todos los clientes son de Costa Rica (CLAUDE.md). */
const TIME_ZONE = 'America/Costa_Rica';

/**
 * Escapa texto para incrustarlo en HTML. TODO dato que venga de la BD pasa por
 * aqui: nombres, direcciones y descripciones son texto libre que alguien digito,
 * y un `<` suelto romperia el documento (o algo peor).
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

/** Instante UTC -> fecha y hora de Costa Rica (CLAUDE.md: se guarda UTC, se muestra local). */
function stamp(iso: string): string {
  return new Date(iso).toLocaleString('es-CR', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Un paquete del recorrido. */
export interface DeliveryReportRow {
  id: string;
  /** Proforma del paquete. Null en paquetes anteriores al modulo de proformas. */
  proformaId: string | null;
  proformaNumber: number | null;
  code: string;
  tracking: string;
  /** HAWB (LES) de la bodega de Miami. Null mientras el paquete no ha llegado. */
  hawb: string | null;
  description: string;
  shipmentType: ShipmentType;
  clientName: string;
  clientPhone: string | null;
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
  routeNumber: number | null;
  /** Estatus de cobro, derivado por el servicio con `collectionStatus`. */
  collection: CollectionStatus;
  /** Saldo pendiente y la moneda EN QUE SE COBRA el trámite (`chargeBasisFor`). */
  due: number;
  dueCurrency: Currency;
}

/**
 * Una parada del recorrido: una proforma con sus paquetes en ruta, que el
 * mensajero entrega en una sola visita y con una sola firma. Un paquete sin
 * proforma es su propia parada (`proformaNumber` null).
 */
export interface DeliveryReportStop {
  proformaNumber: number | null;
  /** Paquetes de la parada. Todos del mismo cliente: la proforma es de uno solo. */
  rows: DeliveryReportRow[];
  /** Saldo por cobrar en la puerta, por moneda. Vacio si no hay nada que cobrar. */
  dueTotals: { currency: Currency; amount: number }[];
}

/** Las paradas de una ruta. `routeNumber` null = direcciones sin ruta asignada. */
export interface DeliveryReportRoute {
  routeNumber: number | null;
  stops: DeliveryReportStop[];
  /** Paquetes de la ruta, sumando todas sus paradas. */
  packages: number;
}

/** Lo que hace falta para armar el documento. */
export interface DeliveryReportDoc {
  /** Instante de generacion, en UTC (ISO 8601). */
  generatedAt: string;
  /** Filtro con el que se pidio, para que el papel diga de que es. */
  filter: { q?: string; routeNumber?: number };
  routes: DeliveryReportRoute[];
  /** Paquetes en la cola con ese filtro, aunque no quepan todos en el documento. */
  total: number;
  /** Cuantos se quedaron fuera por el tope. Se anuncia impreso, no solo en un log. */
  omitted: number;
}

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #f3f4f6; color: #111827;
    font: 12px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  .sheet {
    width: 297mm; min-height: 210mm; margin: 12px auto; padding: 12mm;
    background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.15);
  }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: .5px; }
  .brand small { display: block; font-size: 11px; font-weight: 400; color: #6b7280; letter-spacing: 0; }
  .head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  .meta { text-align: right; font-size: 11px; color: #374151; }
  .meta .scope { font-size: 15px; font-weight: 700; color: #111827; }
  .notice { margin: 14px 0 0; padding: 8px 10px; background: #fef3c7; border: 1px solid #fcd34d; font-size: 11px; }
  h2 {
    margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #111827;
    font-size: 13px; letter-spacing: 1px; text-transform: uppercase;
  }
  h2 span { float: right; font-weight: 400; letter-spacing: 0; text-transform: none; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td {
    padding: 6px 5px; border-bottom: 1px solid #e5e7eb;
    text-align: left; vertical-align: top; overflow-wrap: anywhere;
  }
  th { font-size: 10px; letter-spacing: .5px; text-transform: uppercase; color: #374151; background: #f9fafb; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
  .sub { color: #6b7280; }
  .empty { color: #9ca3af; }
  /* El saldo es lo unico de la fila que cambia lo que el mensajero hace al llegar. */
  .due { font-weight: 700; color: #92400e; white-space: nowrap; }
  .paid { color: #166534; }
  /* Paquetes de la parada: uno por linea, con su cobro a la derecha. */
  .pkg { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; }
  .pkg + .pkg { border-top: 1px dashed #e5e7eb; }
  .pkg .num { text-align: right; flex: none; }
  /* Casilla de firma: se rellena a mano, asi que se deja alta y con linea. */
  .sign { height: 34px; border-bottom: 1px solid #9ca3af; }
  .foot { margin-top: 20px; font-size: 10px; color: #6b7280; }
  .toolbar { max-width: 297mm; margin: 12px auto -4px; text-align: right; }
  .toolbar button {
    padding: 8px 14px; border: 1px solid #111827; border-radius: 6px;
    background: #111827; color: #fff; font: inherit; cursor: pointer;
  }
  @media print {
    body { background: #fff; }
    .toolbar { display: none; }
    .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    /* Una parada no se parte entre dos hojas, y la cabecera se repite en cada una. */
    tr { page-break-inside: avoid; }
    thead { display: table-header-group; }
  }
  /* Apaisado: son seis columnas anchas y en vertical la direccion queda en un hilo. */
  @page { size: A4 landscape; margin: 10mm; }
`;

/** Direccion completa: el mensajero maneja con esto, no con los codigos. */
function address(row: DeliveryReportRow): string {
  const parts = [
    findProvince(row.provinceCode)?.name,
    findCanton(row.cantonCode)?.name,
    findDistrict(row.districtCode)?.name,
  ].filter(Boolean);
  const line = row.addressLine ? `<div class="sub">${esc(row.addressLine)}</div>` : '';
  return `<div>${esc(parts.join(', '))}</div>${line}`;
}

/**
 * El HAWB (LES), el numero que la bodega de Miami imprime en la etiqueta de la
 * caja. Es el que el mensajero tiene delante al cargar el carro, asi que va en la
 * hoja junto al trámite y al tracking, no en su lugar: son tres numeros distintos
 * y cada uno lo pide alguien (la etiqueta, la oficina y el cliente).
 *
 * Solo en los tipos que lo tienen (`usesPackageFields`): en Agenciamiento y
 * Transporte el campo no existe, y una raya ahi se leeria como un dato que falta.
 * Cuando SI aplica y esta vacio, la raya se imprime, porque ese hueco es el dato.
 */
function les(row: DeliveryReportRow): string {
  if (!usesPackageFields(row.shipmentType)) return '';
  const value = row.hawb ? esc(row.hawb) : '<span class="empty">—</span>';
  return `<div class="sub mono">LES: ${value}</div>`;
}

/**
 * La celda del cobro. Imprime el ESTATUS y, cuando queda saldo, el importe en la
 * moneda en que se cobra el trámite: un "pendiente" sin cifra obliga al mensajero
 * a llamar a la oficina desde la puerta del cliente.
 */
function collection(row: DeliveryReportRow): string {
  if (row.collection === CollectionStatus.Pagado) {
    return `<span class="paid">${esc(COLLECTION_STATUS_LABELS[row.collection])}</span>`;
  }
  if (row.collection === CollectionStatus.SinFacturar) {
    return `<span class="empty">${esc(COLLECTION_STATUS_LABELS[row.collection])}</span>`;
  }
  return `<span class="due">${esc(formatMoney(row.due, row.dueCurrency))}</span>
    <div class="sub">${esc(COLLECTION_STATUS_LABELS[row.collection])}</div>`;
}

/** Un paquete dentro de la parada: sus tres numeros, que es, y su propio cobro. */
function packageLine(row: DeliveryReportRow): string {
  return `<div class="pkg">
    <div>
      <div class="mono">${esc(row.code)} <span class="sub">· ${esc(row.tracking)}</span></div>
      ${les(row)}
      <div class="sub">${esc(row.description)} · ${esc(SHIPMENT_TYPE_LABELS[row.shipmentType])}</div>
    </div>
    <div class="num">${collection(row)}</div>
  </div>`;
}

/**
 * El cobro de la parada entera: lo que el mensajero cobra en la puerta. Con
 * saldo, la suma por moneda (una fila por moneda, nunca mezcladas en una cifra).
 * Sin saldo, "Pagado" si todo lo facturado esta cubierto, y se avisa si algun
 * paquete va sin facturar, porque eso tambien es algo que preguntar en la oficina.
 */
function stopCollection(stop: DeliveryReportStop): string {
  if (stop.dueTotals.length > 0) {
    const amounts = stop.dueTotals
      .map((t) => `<div class="due">${esc(formatMoney(t.amount, t.currency))}</div>`)
      .join('');
    return `${amounts}<div class="sub">Por cobrar</div>`;
  }
  const unbilled = stop.rows.filter((r) => r.collection === CollectionStatus.SinFacturar).length;
  if (unbilled === stop.rows.length) {
    return `<span class="empty">${esc(COLLECTION_STATUS_LABELS[CollectionStatus.SinFacturar])}</span>`;
  }
  const note = unbilled > 0 ? `<div class="sub">${unbilled} sin facturar</div>` : '';
  return `<span class="paid">${esc(COLLECTION_STATUS_LABELS[CollectionStatus.Pagado])}</span>${note}`;
}

/**
 * Una ruta: su titulo y su tabla de paradas, numeradas en el orden del recorrido.
 * Una fila por PROFORMA, con cliente, direccion, cobro total y firma una sola
 * vez, y sus paquetes listados adentro: es una visita, no N.
 */
function routeTable(route: DeliveryReportRoute): string {
  const title = route.routeNumber != null ? `Ruta ${route.routeNumber}` : 'Sin ruta asignada';
  const stops = route.stops.length;
  const count =
    `${stops} parada${stops === 1 ? '' : 's'} · ` +
    `${route.packages} paquete${route.packages === 1 ? '' : 's'}`;
  const rows = route.stops
    .map((stop, i) => {
      // Una parada nace con su primer paquete, asi que nunca viene vacia.
      const first = stop.rows[0]!;
      const proforma =
        stop.proformaNumber != null
          ? `<div class="mono"><strong>Proforma #${esc(stop.proformaNumber)}</strong></div>`
          : '<div class="sub">Sin proforma</div>';
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>
          ${proforma}
          <div>${esc(first.clientName)}</div>
          <div class="sub mono">${first.clientPhone ? esc(first.clientPhone) : '—'}</div>
        </td>
        <td>${address(first)}</td>
        <td>${stop.rows.map(packageLine).join('')}</td>
        <td class="num">${stopCollection(stop)}</td>
        <td class="sign"></td>
      </tr>`;
    })
    .join('');

  return `<h2>${esc(title)}<span>${count}</span></h2>
  <table>
    <colgroup>
      <col style="width:4%"><col style="width:16%"><col style="width:19%">
      <col style="width:36%"><col style="width:11%"><col style="width:14%">
    </colgroup>
    <thead><tr>
      <th class="num">#</th><th>Proforma / Cliente / Teléfono</th><th>Dirección</th>
      <th>Paquetes (Trámite · Tracking / LES)</th><th class="num">Cobro</th>
      <th>Recibido por (firma)</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * El documento entero. Una ruta o todas: la unica diferencia es cuantas tablas
 * lleva, y el titulo lo dice para que nadie confunda la hoja de UNA ruta con la
 * del dia completo.
 */
export function renderDeliveryReport(doc: DeliveryReportDoc): string {
  const scope =
    doc.filter.routeNumber != null ? `Ruta ${doc.filter.routeNumber}` : 'Todas las rutas';
  const search = doc.filter.q ? `<div>Búsqueda: “${esc(doc.filter.q)}”</div>` : '';

  /*
   * Lo recortado va IMPRESO y no solo en un log: una hoja que dice "todas las
   * rutas" y trae 500 de 640 paquetes es exactamente el silencio que deja media
   * ruta sin repartir.
   */
  const notice =
    doc.omitted > 0
      ? `<div class="notice">
           Se omitieron ${doc.omitted} paquetes por el límite de impresión. Filtra por ruta y vuelve a generarlo.
         </div>`
      : '';

  const body =
    doc.routes.length > 0
      ? doc.routes.map(routeTable).join('\n')
      : '<p class="empty">No hay paquetes en ruta para ese filtro.</p>';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entregas · ${esc(scope)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="toolbar"><button type="button" onclick="window.print()">Imprimir o guardar PDF</button></div>
<section class="sheet">
  <div class="head">
    <div class="brand">HS Global Services<small>Hoja de ruta de entregas</small></div>
    <div class="meta">
      <div class="scope">${esc(scope)}</div>
      <div>${doc.total} paquete${doc.total === 1 ? '' : 's'} en ruta</div>
      <div>Generado: ${esc(stamp(doc.generatedAt))}</div>
      ${search}
    </div>
  </div>
  ${notice}
  ${body}
  <div class="foot">
    Documento operativo interno. El desenlace de cada visita se registra en el portal de Entregas.
  </div>
</section>
</body>
</html>`;
}
