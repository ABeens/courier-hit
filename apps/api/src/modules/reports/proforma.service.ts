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
 * 3. SE IMPRIME EN LA MONEDA EN QUE SE TRAMITO. La moneda del documento sale de
 *    las lineas de costo (`invoiceCurrency`), no de una constante: un
 *    agenciamiento cargado en colones se entrega en colones. El otro total va de
 *    referencia. Cada linea se convierte con SU propia tasa (regla M5) y los
 *    totales usan la tasa congelada del tramite, no la vigente de hoy: la
 *    proforma tiene que dar el mismo colon que la factura que la origino.
 */
import {
  CostCategory,
  Currency,
  PaymentStatus,
  Permission,
  breakdownByCategory,
  can,
  computeTotals,
  convertMoney,
  findCanton,
  findDistrict,
  findProvince,
  formatConsolidatedProformaNumber,
  invoiceCurrency,
  paymentGroupStatus,
  roundMoney,
  settledAmount,
  totalIn,
} from '@courier/shared';
import type {
  ConsolidatedProformaDto,
  ConsolidatedProformaItem,
  ConsolidatedProformaListItem,
  ProformaBatchSummary,
  ProformaDto,
  ProformaLine,
  ProformaQuery,
  Session,
  ShipmentType,
} from '@courier/shared';
import { AuthErrors, CostErrors, PaymentErrors, ShipmentErrors } from '../../core/errors';
import { consolidatedRepo } from '../payments/consolidated.repo';
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

    /**
     * La moneda del documento es la del TRAMITE: la que el operador uso al cargar
     * los costos. Se pregunta a las lineas y no al tipo de tramite porque es la
     * linea la que lleva el dato; el tipo solo sugiere un valor por defecto en la
     * pantalla de costos, y el operador puede haberlo cambiado.
     */
    const currency = invoiceCurrency(row.lines);

    const lines: ProformaLine[] = row.lines.map((line) => ({
      quantity: 1,
      label: line.label,
      electronicInvoiceCode: line.electronicInvoiceCode,
      amount: convertMoney(line.amount, line.currency, currency, line.exchangeRate),
    }));

    const totals = computeTotals(row.lines);
    const breakdown = breakdownByCategory(row.lines, currency);

    return {
      shipmentId: row.id,
      number: row.code,
      issuedAt: row.costsApprovedAt.toISOString(),
      exchangeRate,
      currency,
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
        freight: breakdown.flete,
        // La columna "Otros / Permisos" de la plantilla junta lo trasladado que no
        // es impuesto con lo que son honorarios nuestros: para el cliente es una
        // sola cosa (lo que se le cobra aparte del flete y los impuestos).
        others: roundMoney(breakdown.otros + breakdown.propio, currency),
        taxes: breakdown.impuestos,
        total: totalIn(totals, currency),
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
      },
      electronicInvoiceNumber: row.electronicInvoiceNumber,
    };
  },

  /**
   * CUANTAS proformas hay listas en el filtro actual, para que la pantalla lo
   * diga antes de abrirlas: "descargar todas" sin saber cuantas son es como
   * alguien acaba abriendo un documento de trescientas paginas sin querer.
   *
   * Es un conteo y no la lista: la pantalla no pinta ninguna proforma, solo el
   * numero. Antes se armaban las 200 del lote (tres consultas por tramite) para
   * devolver algo que nadie miraba, y el numero salia YA RECORTADO por el tope,
   * asi que se quedaba en 200 con cualquier filtro y parecia que filtrar no hacia
   * nada. `omitted` viaja al lado porque es la otra mitad de la misma verdad: lo
   * que hay y lo que va a caber.
   */
  async readyCount(session: Session, query: ProformaQuery): Promise<ProformaBatchSummary> {
    if (!can(session.role, Permission.ReportsProforma)) throw AuthErrors.forbidden();

    const total = await reportsRepo.countBilledShipments(query);
    return { total, omitted: Math.max(0, total - BATCH_LIMIT) };
  },

  /**
   * Las proformas listas, completas, para imprimirlas de una sola vez.
   *
   * El tope existe porque el lote se arma en memoria: 200 proformas ya son un
   * documento de cientos de paginas, y mas alla de eso lo que hace falta no es un
   * limite mas alto sino un filtro mas estrecho. Lo recortado se anuncia impreso
   * (ver `renderProformas`), nunca en silencio.
   */
  async batch(session: Session, query: ProformaQuery): Promise<ProformaDto[]> {
    if (!can(session.role, Permission.ReportsProforma)) throw AuthErrors.forbidden();

    const ids = await reportsRepo.billedShipmentIds(query);
    const out: ProformaDto[] = [];
    for (const id of ids.slice(0, BATCH_LIMIT)) out.push(await this.get(session, id));
    return out;
  },

  // -------------------------------------------------------------------------
  // Proforma CONSOLIDADA (un documento por cobro agrupado)
  // -------------------------------------------------------------------------

  /**
   * Proforma de un COBRO AGRUPADO: todos los paquetes que se saldaron juntos y el
   * monto total pagado.
   *
   * Se arma igual que la suelta (no se guarda, se deriva) pero la unidad es el
   * grupo. Cada paquete aporta su desglose por categoria con las MISMAS funciones
   * que la proforma individual: si algun dia cambia como se reparte un concepto
   * entre "otros" e "impuestos", los dos documentos cambian juntos.
   */
  async getConsolidated(session: Session, groupId: string): Promise<ConsolidatedProformaDto> {
    if (!can(session.role, Permission.ReportsProforma)) throw AuthErrors.forbidden();

    const group = await consolidatedRepo.findGroup(groupId);
    if (!group) throw PaymentErrors.groupNotFound();

    const lines = await consolidatedRepo.groupPayments(groupId);
    if (lines.length === 0) throw PaymentErrors.groupNotFound();

    /**
     * La moneda del documento es la del COBRO, no la de las lineas de cada
     * paquete: el grupo ya se cobro en una moneda concreta y el recibo del cliente
     * habla en esa. Lo pagado y lo facturado tienen que poder compararse sin que
     * el lector convierta nada.
     */
    const currency = group.currency;

    const items: ConsolidatedProformaItem[] = [];
    let client: ConsolidatedProformaDto['client'] | null = null;
    let totalUsd = 0;
    let totalCrc = 0;

    for (const line of lines) {
      const row = await reportsRepo.proformaRow(line.shipmentId);
      // Un paquete sin costos aprobados no puede estar en un cobro: si aparece, es
      // que le reversaron la factura despues, y lo honesto es dejarlo fuera del
      // documento en vez de imprimir un detalle en blanco.
      if (!row || !row.costsApprovedAt || row.lines.length === 0) continue;

      const breakdown = breakdownByCategory(row.lines, currency);
      const totals = computeTotals(row.lines);
      totalUsd += totals.usd;
      totalCrc += totals.crc;

      client ??= {
        name: row.clientName,
        idNumber: row.idNumber,
        phone: row.clientPhone,
        address: formatAddress(row),
        email: row.clientEmail,
      };

      items.push({
        shipmentId: row.id,
        code: row.code,
        awb: row.hawb ?? row.tracking,
        tracking: row.tracking,
        description: row.description,
        weightKg: row.weightKg,
        freight: breakdown.flete,
        others: roundMoney(breakdown.otros + breakdown.propio, currency),
        taxes: breakdown.impuestos,
        total: totalIn(totals, currency),
        lines: row.lines.map((l) => ({
          quantity: 1,
          label: l.label,
          electronicInvoiceCode: l.electronicInvoiceCode,
          amount: convertMoney(l.amount, l.currency, currency, l.exchangeRate),
        })),
      });
    }

    if (items.length === 0 || !client) throw CostErrors.notApproved();

    /**
     * Lo PAGADO son los abonos confirmados del grupo, con la misma funcion que
     * totaliza cualquier cobro. No se da por pagado el total solo porque exista el
     * grupo: un deposito sin validar sigue sin ser dinero recibido, y el documento
     * tiene que poder decirlo (`paidStatus`).
     */
    const status = paymentGroupStatus(lines.map((l) => l.status));
    const confirmedAt = lines
      .filter((l) => l.status === PaymentStatus.Confirmado && l.confirmedAt)
      .map((l) => l.confirmedAt as Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    return {
      paymentGroupId: group.id,
      number: formatConsolidatedProformaNumber(group.id),
      issuedAt: group.createdAt.toISOString(),
      exchangeRate: group.exchangeRate,
      currency,
      client,
      rateName: group.rateName ?? 'Consolidada',
      items,
      totalUsd: roundMoney(totalUsd, Currency.USD),
      totalCrc: roundMoney(totalCrc, Currency.CRC),
      paidAmount: settledAmount(lines, currency),
      paidStatus: status,
      paidAt: status === PaymentStatus.Confirmado && confirmedAt ? confirmedAt.toISOString() : null,
      method: group.method,
    };
  },

  /**
   * Los cobros agrupados del filtro. Van TODOS, sin recortar por el tope: el
   * recorte lo hace `consolidatedBatch`, que es quien arma el documento. Contar
   * sobre una lista ya recortada era lo que dejaba el numero clavado en el tope
   * dijera lo que dijera el filtro.
   */
  async readyConsolidated(
    session: Session,
    query: ProformaQuery,
  ): Promise<ConsolidatedProformaListItem[]> {
    if (!can(session.role, Permission.ReportsProforma)) throw AuthErrors.forbidden();

    const groups = await consolidatedRepo.listGroups({
      clientId: query.clientId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });

    const byGroup = new Map<
      string,
      { statuses: PaymentStatus[]; shipments: Set<string>; types: Set<ShipmentType> }
    >();
    for (const line of await consolidatedRepo.paymentsForGroups(groups.map((g) => g.id))) {
      if (!line.groupId) continue;
      const entry = byGroup.get(line.groupId) ?? {
        statuses: [],
        shipments: new Set<string>(),
        types: new Set<ShipmentType>(),
      };
      entry.statuses.push(line.status);
      entry.shipments.add(line.shipmentId);
      entry.types.add(line.shipmentType);
      byGroup.set(line.groupId, entry);
    }

    const items: ConsolidatedProformaListItem[] = [];
    for (const group of groups) {
      const entry = byGroup.get(group.id);
      // Un grupo con todos sus cobros INICIADOS es un formulario de tarjeta que
      // alguien abrio y no llego a usar: no hay documento que emitir.
      if (!entry || entry.statuses.every((s) => s === PaymentStatus.Iniciado)) continue;

      /**
       * El filtro por tipo de tramite recorta QUE COBROS salen, no que paquetes
       * lleva cada uno: un cobro agrupado es UNA factura, y quitarle paquetes por
       * un filtro de pantalla daria un documento cuyo total no cuadra con lo que
       * se cobro. Entra el grupo que tenga al menos un paquete del tipo pedido.
       *
       * Sin esto el filtro se perdia por el camino (`listGroups` solo recibia
       * cliente y fechas) y el boton contaba SIEMPRE todos los cobros, dijera lo
       * que dijera el selector de tramite.
       */
      if (query.shipmentType && !query.shipmentType.some((t) => entry.types.has(t))) continue;

      items.push({
        paymentGroupId: group.id,
        number: formatConsolidatedProformaNumber(group.id),
        clientName: group.clientName,
        clientCode: group.clientCode,
        issuedAt: group.createdAt.toISOString(),
        itemCount: entry.shipments.size,
        // El listado solo necesita una cifra de referencia: el total del cobro
        // reexpresado con SU tasa congelada. El desglose exacto lo da el documento.
        totalUsd: roundMoney(group.amount / group.exchangeRate, Currency.USD),
        paidStatus: paymentGroupStatus(entry.statuses),
      });
    }
    return items;
  },

  /** Cuantos cobros consolidados hay listos en el filtro, y cuantos no caben. */
  async readyConsolidatedCount(
    session: Session,
    query: ProformaQuery,
  ): Promise<ProformaBatchSummary> {
    const total = (await this.readyConsolidated(session, query)).length;
    return { total, omitted: Math.max(0, total - BATCH_LIMIT) };
  },

  /**
   * Las proformas consolidadas del filtro, completas, en un solo documento.
   *
   * Devuelve tambien cuantas quedaron fuera por el tope, y no lo deja para otra
   * llamada, porque ya lo sabe: preguntarlo aparte recorreria los mismos grupos
   * una segunda vez para responder algo que este recorrido tiene delante.
   */
  async consolidatedBatch(
    session: Session,
    query: ProformaQuery,
  ): Promise<{ proformas: ConsolidatedProformaDto[]; omitted: number }> {
    const listed = await this.readyConsolidated(session, query);
    const proformas: ConsolidatedProformaDto[] = [];
    for (const item of listed.slice(0, BATCH_LIMIT)) {
      // Un grupo al que le reversaron las facturas no rompe el lote: se omite.
      try {
        proformas.push(await this.getConsolidated(session, item.paymentGroupId));
      } catch {
        continue;
      }
    }
    return { proformas, omitted: Math.max(0, listed.length - BATCH_LIMIT) };
  },
};

/** Categorias que la plantilla imprime como "Otros / Permisos". Solo documental. */
export const PROFORMA_OTHERS_CATEGORIES: readonly CostCategory[] = [
  CostCategory.Otros,
  CostCategory.Propio,
];
