/**
 * Proforma de un tramite: el documento que se le entrega al cliente.
 * Plantilla de referencia: `source_docs/Material/Ejemplo de Proforma.xlsx`.
 *
 * Tres decisiones que viven aqui:
 *
 * 1. SE ARMA, NO SE GUARDA. La proforma se deriva del tramite, su cliente y sus
 *    lineas de costo cada vez que se pide. No hay tabla ni consecutivo propio: si
 *    se reversan los costos, la proforma vieja simplemente deja de existir, que es
 *    la respuesta correcta. Persistirla obligaria a decidir que hacer con una
 *    proforma que ya no representa ninguna factura.
 * 2. SOLO SOBRE TRAMITES FACTURADOS. Sin costos aprobados no hay total que
 *    imprimir; se responde 409 y no una proforma en blanco.
 * 3. LOS IMPORTES SE REEXPRESAN EN USD CON LA TASA DE LA FACTURA. Cada linea se
 *    convierte con SU propia tasa (regla M5) y el total en colones se calcula con
 *    la tasa congelada del tramite, no con la vigente de hoy: la proforma tiene
 *    que dar el mismo colon que la factura que la origino.
 */
import {
  CostCategory,
  Currency,
  Permission,
  breakdownByCategory,
  can,
  computeTotals,
  convertMoney,
  findCanton,
  findDistrict,
  findProvince,
  roundMoney,
} from '@courier/shared';
import type { ProformaDto, ProformaLine, ProformaListItem, ProformaQuery, Session } from '@courier/shared';
import { AuthErrors, CostErrors, ShipmentErrors } from '../../core/errors';
import { reportsRepo } from './reports.repo';

/** Tope de proformas que se descargan de una sola vez (ver `batch`). */
const BATCH_LIMIT = 200;

/**
 * Direccion del cliente en una linea, resuelta desde el catalogo territorial.
 * En el ejemplo la celda dice "Alajuela. CR": provincia y pais. Aqui se da el
 * detalle completo porque es lo que el cliente reconoce como suyo y el catalogo
 * ya lo tiene; el pais sobra en un documento que solo opera en Costa Rica.
 */
function formatAddress(row: {
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
}): string {
  const parts = [
    findProvince(row.provinceCode)?.name,
    findCanton(row.cantonCode)?.name,
    findDistrict(row.districtCode)?.name,
    row.addressLine,
  ].filter(Boolean);
  return parts.join(', ');
}

export const proformaService = {
  /**
   * Proforma de UN tramite. El permiso se comprueba aqui y no en un middleware
   * porque la ruta comparte prefijo con los reportes, que tienen otra barrera.
   */
  async get(session: Session, shipmentId: string): Promise<ProformaDto> {
    if (!can(session.role, Permission.ReportsProforma)) throw AuthErrors.forbidden();

    const row = await reportsRepo.proformaRow(shipmentId);
    if (!row) throw ShipmentErrors.notFound();
    // Regla del negocio: "las proformas solo se generan en paquetes ya facturados".
    if (!row.costsApprovedAt || row.lines.length === 0) throw CostErrors.notApproved();

    /**
     * La tasa del documento es la de las lineas, no la vigente. Todas comparten
     * la misma (el guardado la estampa en el juego completo), asi que basta la
     * primera; el `?? 1` no llega a usarse nunca porque sin lineas ya se salio
     * arriba, y existe para no arrastrar un `!` por el resto de la funcion.
     */
    const exchangeRate = row.lines[0]?.exchangeRate ?? 1;

    const lines: ProformaLine[] = row.lines.map((line) => ({
      quantity: 1,
      label: line.label,
      electronicInvoiceCode: line.electronicInvoiceCode,
      amountUsd: convertMoney(line.amount, line.currency, Currency.USD, line.exchangeRate),
    }));

    const totals = computeTotals(row.lines);
    const breakdown = breakdownByCategory(row.lines, Currency.USD);

    return {
      shipmentId: row.id,
      number: row.code,
      issuedAt: row.costsApprovedAt.toISOString(),
      exchangeRate,
      client: {
        name: row.clientName,
        idNumber: row.idNumber,
        phone: row.clientPhone,
        address: formatAddress(row),
        email: row.clientEmail,
      },
      lines,
      totalUsd: totals.usd,
      totalCrc: totals.crc,
      detail: {
        awb: row.hawb ?? row.tracking,
        description: row.description,
        weightKg: row.weightKg,
        tracking: row.tracking,
        freightUsd: breakdown.flete,
        // La columna "Otros / Permisos" de la plantilla junta lo trasladado que no
        // es impuesto con lo que son honorarios nuestros: para el cliente es una
        // sola cosa (lo que se le cobra aparte del flete y los impuestos).
        othersUsd: roundMoney(breakdown.otros + breakdown.propio, Currency.USD),
        taxesUsd: breakdown.impuestos,
        totalUsd: totals.usd,
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
      },
      electronicInvoiceNumber: row.electronicInvoiceNumber,
    };
  },

  /**
   * Proformas LISTAS del filtro actual: los tramites ya facturados.
   *
   * Devuelve la lista para que la pantalla diga cuantas va a bajar antes de
   * hacerlo. El tope existe porque el lote se arma en memoria: 200 proformas ya
   * son un documento de cientos de paginas, y mas alla de eso lo que hace falta
   * no es un limite mas alto sino un filtro mas estrecho.
   */
  async ready(session: Session, query: ProformaQuery): Promise<ProformaListItem[]> {
    if (!can(session.role, Permission.ReportsProforma)) throw AuthErrors.forbidden();

    const ids = await reportsRepo.billedShipmentIds(query);
    const items: ProformaListItem[] = [];
    for (const id of ids.slice(0, BATCH_LIMIT)) {
      const proforma = await this.get(session, id);
      items.push({
        shipmentId: proforma.shipmentId,
        number: proforma.number,
        clientName: proforma.client.name,
        issuedAt: proforma.issuedAt,
        totalUsd: proforma.totalUsd,
        electronicInvoiceNumber: proforma.electronicInvoiceNumber,
      });
    }
    return items;
  },

  /** Las proformas listas, completas, para imprimirlas de una sola vez. */
  async batch(session: Session, query: ProformaQuery): Promise<ProformaDto[]> {
    if (!can(session.role, Permission.ReportsProforma)) throw AuthErrors.forbidden();

    const ids = await reportsRepo.billedShipmentIds(query);
    const out: ProformaDto[] = [];
    for (const id of ids.slice(0, BATCH_LIMIT)) out.push(await this.get(session, id));
    return out;
  },

  /** Cuantas proformas quedaron fuera del lote por el tope. 0 = salieron todas. */
  async omittedFrom(query: ProformaQuery): Promise<number> {
    const ids = await reportsRepo.billedShipmentIds(query);
    return Math.max(0, ids.length - BATCH_LIMIT);
  },
};

/** Categorias que la plantilla imprime como "Otros / Permisos". Solo documental. */
export const PROFORMA_OTHERS_CATEGORIES: readonly CostCategory[] = [
  CostCategory.Otros,
  CostCategory.Propio,
];
