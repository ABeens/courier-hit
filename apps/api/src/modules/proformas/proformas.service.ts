/**
 * Reglas de negocio de las proformas (docs/proformas-cambios.html, areas 3, 4, 9
 * y 10). El armado automatico de los borradores vive aparte, en
 * `proforma-drafts.service`, porque lo disparan las transiciones.
 *
 * Cinco decisiones que viven aqui:
 *
 * 1. APROBAR CONGELA LA PROFORMA Y SUS TRAMITES JUNTOS. En UNA transaccion se
 *    asigna el numero (contador con bloqueo, sin huecos), se congela la factura
 *    de cada tramite y los totales de la proforma. Despues, y solo si eso entro,
 *    los tramites avanzan a su estado de cobro. En bloque, cada proforma va en su
 *    propia transaccion: una que falla no deshace las demas.
 * 2. CORREGIR DEVUELVE A BORRADOR SIN PERDER EL NUMERO. Solo una aprobada y sin
 *    pagos (ni confirmados ni en validacion). Los tramites vuelven a "Facturacion
 *    en proceso" (Transporte ya estaba ahi) y la factura se descongela. Al
 *    reaprobar sale con el mismo numero.
 * 3. LOS SERVICIOS ADICIONALES SON DE LA PROFORMA (decision D10). El flete de
 *    cada paquete y los costos propios de cada tramite siguen en el tramite; lo
 *    que se cobra por la proforma entera va en `proforma_costs`.
 * 4. MOVER ES LA UNICA FORMA DE REAGRUPAR. Sacar un paquete (a una proforma
 *    nueva o a otro borrador) y juntar tramites de Transporte o Agenciamiento son
 *    la misma operacion, con las reglas de `joinBlockFor`.
 * 5. EL DOCUMENTO SE ARMA DESDE LO GUARDADO. Una aprobada imprime sus totales
 *    congelados; un borrador, una vista previa con la marca BORRADOR.
 *
 * Todo cambio de montos pasa por las funciones de @courier/shared
 * (`computeTotals`, `convertMoney`, `breakdownByCategory`): aqui no se suma ni
 * se redondea nada a mano (regla M4).
 */
import {
  CARD_SURCHARGE_LABEL,
  CORRECTION_NOTE_PREFIX,
  CostLineSource,
  Currency,
  Flow,
  PROFORMA_JOIN_BLOCK_MESSAGES,
  PaymentStatus,
  ProformaStatus,
  State,
  allocateProformaInvoices,
  applyPercentage,
  asRealCosts,
  breakdownByCategory,
  canSetExchangeRate,
  canTransition,
  categoryForLine,
  computeTotals,
  convertMoney,
  costLineExchangeRateSchema,
  displayedWeightKg,
  findCanton,
  findDistrict,
  findProvince,
  formatProformaNumber,
  isProformaEditable,
  joinBlockFor,
  payableStateOf,
  paymentGateWaived,
  percentageBase,
  proformaDeliveryStatus,
  realAmountOf,
  roundMoney,
  sumInvoices,
  totalIn,
} from '@courier/shared';
import type {
  ApproveProformasResult,
  AssignShipmentOwnerInput,
  DispatchProformasResult,
  CorrectProformaInput,
  CostLineDto,
  ListProformasQuery,
  MoveProformaShipmentInput,
  Page,
  ProformaCounterDto,
  ProformaDetailDto,
  ProformaFilter,
  ProformaListItem,
  ProformaShipmentDto,
  SaveProformaCostsInput,
  Session,
  SetProformaCounterInput,
  ShipmentCostsDto,
  UpdateProformaInput,
} from '@courier/shared';
import { AppError, CostErrors, ProformaErrors } from '../../core/errors';
import { db } from '../../core/db';
import { costServicesRepo } from '../cost-services/cost-services.repo';
import { catalogSuggestions, resolveLines } from '../costs/costs.service';
import { exchangeRateReference } from '../settings/exchange-rate-reference';
import { paymentsRepo } from '../payments/payments.repo';
import { settingsRepo } from '../settings/settings.repo';
import { shipmentsRepo } from '../shipments/shipments.repo';
import { shipmentsService } from '../shipments/shipments.service';
import { transitionsService } from '../shipments/transitions.service';
import type { DocumentItem, DocumentLine, ProformaDocument } from './proforma.render';
import { proformasRepo } from './proformas.repo';

type Header = NonNullable<Awaited<ReturnType<typeof proformasRepo.header>>>;
type ListRow = Awaited<ReturnType<typeof proformasRepo.list>>['rows'][number];
type ShipmentLine = Awaited<ReturnType<typeof proformasRepo.shipmentLinesOf>>[number];
type ProformaLine = Awaited<ReturnType<typeof proformasRepo.proformaLinesOf>>[number];
type Line = ShipmentLine | ProformaLine;

/** Fila de linea -> DTO de la API (fechas en ISO/UTC). */
function toLineDto(row: Line): CostLineDto {
  return {
    id: row.id,
    costServiceId: row.costServiceId,
    label: row.label,
    category: row.category,
    electronicInvoiceCode: row.electronicInvoiceCode,
    source: row.source,
    percentage: row.percentage,
    amount: row.amount,
    realAmount: realAmountOf(row),
    currency: row.currency,
    exchangeRate: row.exchangeRate,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Agrupa filas por una clave, conservando el orden en que llegaron. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(key(row)) ?? [];
    list.push(row);
    map.set(key(row), list);
  }
  return map;
}

/**
 * Base de los PORCENTAJES de la proforma: las lineas de sus tramites (sin la
 * comision de la tarjeta, que se asienta despues de aprobar) mas sus servicios
 * fijos. `percentageBase` descarta los porcentajes: nunca se calcula uno sobre
 * otro.
 */
function percentageBaseLines(shipmentLines: readonly ShipmentLine[], proformaLines: readonly ProformaLine[]): Line[] {
  return [...shipmentLines.filter((l) => l.paymentId === null), ...proformaLines];
}

/**
 * Los servicios de la proforma con sus porcentajes calculados sobre el subtotal
 * de AHORA. En un borrador el subtotal cambia (entran, salen o cambian paquetes)
 * y el importe guardado puede estar viejo: se recalcula al leer, y la aprobacion
 * congela el resultado. El facturado y el real se recalculan cada uno sobre su
 * propia base, igual que al guardar (`resolveLines`).
 */
function withLivePercentages(proformaLines: readonly ProformaLine[], shipmentLines: readonly ShipmentLine[]): ProformaLine[] {
  const base = percentageBaseLines(shipmentLines, proformaLines);
  const realBase = asRealCosts(base);
  return proformaLines.map((l) =>
    l.source === CostLineSource.Percentage && l.percentage !== null
      ? {
          ...l,
          amount: applyPercentage(percentageBase(base, l.currency), l.percentage, l.currency),
          realAmount: applyPercentage(percentageBase(realBase, l.currency), l.percentage, l.currency),
        }
      : l,
  );
}

/**
 * Totales de la proforma: los CONGELADOS si esta aprobada o pagada, y si es
 * borrador la vista previa con las lineas de ahora (cada una con su tasa, la
 * misma cuenta que hara la aprobacion).
 */
function totalsOf(header: ListRow['proforma'], lines: readonly Line[]): { usd: number; crc: number } {
  if (header.totalUsd !== null && header.totalCrc !== null) {
    return { usd: header.totalUsd, crc: header.totalCrc };
  }
  return computeTotals(lines);
}

function toListItem(row: ListRow, lines: readonly Line[]): ProformaListItem {
  const p = row.proforma;
  return {
    id: p.id,
    number: p.number === null ? null : formatProformaNumber(p.number),
    status: p.status,
    flow: p.flow,
    currency: p.currency,
    client: { id: p.clientId, code: row.clientCode, name: row.clientName },
    shipmentCount: row.shipmentCount,
    totals: totalsOf(p, lines),
    deliveryStatus: proformaDeliveryStatus(p.flow, {
      total: row.shipmentCount,
      delivered: row.deliveredCount,
      finished: row.finishedCount,
    }),
    readyForRouteCount: row.readyForRouteCount,
    paymentGateWaived: paymentGateWaived(p.flow, row.clientPaymentGateExempt),
    electronicInvoiceNumber: p.electronicInvoiceNumber,
    createdAt: p.createdAt.toISOString(),
    approvedAt: p.approvedAt?.toISOString() ?? null,
    paidAt: p.paidAt?.toISOString() ?? null,
  };
}

/** Tope de filas del CSV del listado y de documentos del lote imprimible. */
const EXPORT_LIMIT = 5000;
const DOCUMENTS_LIMIT = 200;

/**
 * Filas de la bandeja con su total. Solo los borradores necesitan sus lineas
 * (vista previa del total, con los porcentajes al dia): las aprobadas traen el
 * total congelado en la fila.
 */
async function toListItems(rows: readonly ListRow[]): Promise<ProformaListItem[]> {
  const draftIds = rows.filter((r) => r.proforma.totalUsd === null).map((r) => r.proforma.id);
  const [shipmentLines, proformaLines] = await Promise.all([
    proformasRepo.shipmentLinesOf(draftIds),
    proformasRepo.proformaLinesOf(draftIds),
  ]);
  const shipmentLinesBy = groupBy(shipmentLines, (l) => l.proformaId);
  const extrasBy = groupBy(proformaLines, (l) => l.proformaId);
  return rows.map((row) => {
    const own = shipmentLinesBy.get(row.proforma.id) ?? [];
    return toListItem(row, [...own, ...withLivePercentages(extrasBy.get(row.proforma.id) ?? [], own)]);
  });
}

/** Tasa vigente del sistema, validada; null si nadie la fijo o no es valida (M5). */
async function currentRate(): Promise<number | null> {
  const checked = costLineExchangeRateSchema.safeParse(await settingsRepo.currentExchangeRate());
  return checked.success ? checked.data : null;
}

/** Direccion del cliente en una linea, resuelta desde el catalogo territorial. */
function formatAddress(row: {
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
}): string {
  return [
    findProvince(row.provinceCode)?.name,
    findCanton(row.cantonCode)?.name,
    findDistrict(row.districtCode)?.name,
    row.addressLine,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Una linea convertida a la moneda del documento, con SU propia tasa (M5). */
function toDocumentLine(line: Line, currency: Currency): DocumentLine {
  return {
    label: line.label,
    electronicInvoiceCode: line.electronicInvoiceCode,
    amount: convertMoney(line.amount, line.currency, currency, line.exchangeRate),
  };
}

/** Carga la cabecera o responde 404. */
async function loadHeader(id: string): Promise<Header> {
  const header = await proformasRepo.header(id);
  if (!header) throw ProformaErrors.notFound();
  return header;
}

/** Carga la proforma exigiendo que siga en borrador. */
async function loadDraft(id: string): Promise<Header> {
  const header = await loadHeader(id);
  if (!isProformaEditable(header.proforma.status)) throw ProformaErrors.notDraft();
  return header;
}

export const proformasService = {
  async list(query: ListProformasQuery): Promise<Page<ProformaListItem>> {
    const { rows, total } = await proformasRepo.list(query);
    return { items: await toListItems(rows), total, page: query.page, pageSize: query.pageSize };
  },

  /**
   * Las proformas del propio cliente: solo las aprobadas y pagadas. El dueño lo
   * pone la sesion y no el query, asi que un `clientId` ajeno no abre nada.
   */
  async listOwn(clientId: string, query: ListProformasQuery): Promise<Page<ProformaListItem>> {
    const { rows, total } = await proformasRepo.list({ ...query, clientId }, true);
    return { items: await toListItems(rows), total, page: query.page, pageSize: query.pageSize };
  },

  /**
   * REPORTE del listado: el filtro entero de la bandeja en CSV, una fila por
   * proforma. Tope `EXPORT_LIMIT`; si recorta, lo dice en la ultima fila.
   */
  async exportList(filter: ProformaFilter): Promise<{ items: ProformaListItem[]; total: number }> {
    const { rows, total } = await proformasRepo.listAll(filter, EXPORT_LIMIT);
    return { items: await toListItems(rows), total };
  },

  /**
   * LOTE para imprimir: los documentos de todas las proformas del filtro, una por
   * pagina (el antiguo "bajar todas las proformas"). Tope `DOCUMENTS_LIMIT`; lo
   * que se queda fuera se dice impreso en el documento.
   */
  async documents(filter: ProformaFilter): Promise<{ docs: ProformaDocument[]; total: number }> {
    const { rows, total } = await proformasRepo.listAll(filter, DOCUMENTS_LIMIT);
    const docs: ProformaDocument[] = [];
    for (const row of rows) docs.push(await this.document(row.proforma.id));
    return { docs, total };
  },

  async get(id: string): Promise<ProformaDetailDto> {
    const header = await loadHeader(id);
    const p = header.proforma;
    const [shipments, shipmentLines, proformaLines] = await Promise.all([
      proformasRepo.shipmentsOf(id),
      proformasRepo.shipmentLinesOf([id]),
      proformasRepo.proformaLinesOf([id]),
    ]);
    const linesByShipment = groupBy(shipmentLines, (l) => l.shipmentId);
    const extras = isProformaEditable(p.status) ? withLivePercentages(proformaLines, shipmentLines) : proformaLines;

    const items: ProformaShipmentDto[] = shipments.map((s) => {
      const lines = linesByShipment.get(s.id) ?? [];
      return {
        id: s.id,
        code: s.code,
        shipmentType: s.shipmentType,
        state: s.state,
        tracking: s.tracking,
        hawb: s.hawb,
        description: s.description,
        weightKg: displayedWeightKg(s.weightKg, s.rateKind),
        lines: lines.map(toLineDto),
        total: totalIn(computeTotals(lines), p.currency),
      };
    });

    const weights = items.map((s) => s.weightKg).filter((w): w is number => w !== null);
    return {
      ...toListItem(header, [...shipmentLines, ...extras]),
      editable: isProformaEditable(p.status),
      accumulates: p.accumulates,
      // El peso no es un monto: se suma (el facturable de cada paquete) y se deja
      // con tres decimales de bascula.
      totalWeightKg: weights.length > 0 ? Math.round(weights.reduce((a, b) => a + b, 0) * 1000) / 1000 : null,
      shipments: items,
      costs: extras.map(toLineDto),
      exchangeRate: p.exchangeRate ?? (await currentRate()),
      approvedByName: header.approvedByName,
    };
  },

  /**
   * Lo que necesita el editor de servicios de la proforma: sus lineas, el
   * catalogo del flujo como sugerencias, el total y la tasa vigente. Misma forma
   * que la del editor de costos de un tramite, para que la pantalla sea la misma.
   */
  async costsView(session: Session, id: string): Promise<ShipmentCostsDto> {
    const header = await loadHeader(id);
    const p = header.proforma;
    const [saved, shipmentLines, suggestions, globalRate, reference] = await Promise.all([
      proformasRepo.proformaLinesOf([id]),
      proformasRepo.shipmentLinesOf([id]),
      catalogSuggestions(p.flow),
      settingsRepo.currentExchangeRate(),
      canSetExchangeRate(session.role) ? exchangeRateReference.suggest() : null,
    ]);
    const editable = isProformaEditable(p.status);
    const lines = editable ? withLivePercentages(saved, shipmentLines) : saved;
    // Lo que los paquetes aportan a la base de los porcentajes, para que la
    // vista previa del editor calcule igual que la API.
    const packagesBase = percentageBaseLines(shipmentLines, []);
    const packagesRealBase = asRealCosts(packagesBase);
    return {
      shipmentId: id,
      lines: lines.map(toLineDto),
      packagesSubtotal: {
        usd: percentageBase(packagesBase, Currency.USD),
        crc: percentageBase(packagesBase, Currency.CRC),
      },
      packagesRealSubtotal: {
        usd: percentageBase(packagesRealBase, Currency.USD),
        crc: percentageBase(packagesRealBase, Currency.CRC),
      },
      suggestions: editable ? suggestions : [],
      totals: computeTotals(lines),
      realTotals: computeTotals(asRealCosts(lines)),
      approved: !editable,
      approvedAt: p.approvedAt?.toISOString() ?? null,
      approvedByName: header.approvedByName,
      globalExchangeRate: globalRate,
      referenceExchangeRate: reference?.rate ?? null,
    };
  },

  /**
   * Reemplaza los servicios adicionales de la proforma (decision D10). Mismas
   * reglas que la carga de costos de un tramite: la tasa la decide quien puede
   * fijarla (al resto se le impone la vigente), los porcentajes los calcula la API
   * y categoria y COD SIS FE se copian del catalogo como snapshot.
   */
  async saveCosts(session: Session, id: string, input: SaveProformaCostsInput) {
    await loadDraft(id);

    let lines = input.lines;
    if (lines.length > 0) {
      let rate: number;
      if (canSetExchangeRate(session.role)) {
        rate = lines[0]!.exchangeRate;
      } else {
        const [saved] = await proformasRepo.proformaLinesOf([id]);
        const checked = costLineExchangeRateSchema.safeParse(saved?.exchangeRate ?? (await settingsRepo.currentExchangeRate()));
        if (!checked.success) throw CostErrors.noExchangeRate();
        rate = checked.data;
      }
      lines = lines.map((l) => ({ ...l, exchangeRate: rate }));
    }

    // Los porcentajes van sobre el subtotal de la proforma entera: sus paquetes
    // entran a la base aunque no se guarden con estas lineas.
    const shipmentLines = await proformasRepo.shipmentLinesOf([id]);
    const resolved = resolveLines(lines, percentageBaseLines(shipmentLines, []));
    const serviceIds = [...new Set(resolved.map((l) => l.costServiceId).filter((x) => x !== null))];
    const byId = new Map((await costServicesRepo.listByIds(serviceIds)).map((s) => [s.id, s]));

    await proformasRepo.replaceProformaLines(
      id,
      resolved.map((l) => {
        const service = l.costServiceId ? byId.get(l.costServiceId) : undefined;
        return {
          ...l,
          proformaId: id,
          category: categoryForLine(l.source, service?.category),
          electronicInvoiceCode: service?.electronicInvoiceCode ?? null,
          createdBy: session.userId,
        };
      }),
    );
    return this.get(id);
  },

  /**
   * Aprueba UNA proforma. Devuelve su numero.
   *
   * Todo lo que se puede comprobar antes se comprueba antes, para responder un
   * error claro sin haber abierto la transaccion. Dentro de ella se vuelve a
   * mirar lo que otra persona pudo cambiar entretanto (el estado y el conjunto de
   * tramites), con la fila bloqueada.
   */
  async approve(session: Session, id: string): Promise<{ id: string; number: string }> {
    const header = await loadDraft(id);
    const p = header.proforma;

    const shipments = await proformasRepo.shipmentsOf(id);
    if (shipments.length === 0) throw ProformaErrors.empty();

    const [shipmentLines, proformaLines] = await Promise.all([
      proformasRepo.shipmentLinesOf([id]),
      proformasRepo.proformaLinesOf([id]),
    ]);
    const linesByShipment = groupBy(shipmentLines, (l) => l.shipmentId);
    // Los porcentajes, sobre el subtotal de este momento: es el que se congela.
    const extras = withLivePercentages(proformaLines, shipmentLines);

    const payable = payableStateOf(p.flow);
    for (const s of shipments) {
      if (s.discardedAt !== null || s.state !== State.FacturacionEnProceso) {
        throw ProformaErrors.shipmentNotBillable(s.code);
      }
      if (s.clientId !== p.clientId) throw ProformaErrors.changed();
      if ((linesByShipment.get(s.id) ?? []).length === 0) {
        throw ProformaErrors.shipmentWithoutCosts(s.code);
      }
      if (!payable || (payable !== s.state && !canTransition(p.flow, s.state, payable))) {
        throw ProformaErrors.shipmentNotBillable(s.code);
      }
    }

    const exchangeRate = await currentRate();
    if (exchangeRate === null) throw CostErrors.noExchangeRate();
    /**
     * La tarifa de transporte internacional se congela con la factura, solo en
     * Paqueteria (la usa el reporte de margen). Que no este fijada no impide
     * aprobar: la factura del cliente no depende de ella.
     */
    const freightRate = p.flow === Flow.Paqueteria ? await settingsRepo.currentFreightRate() : null;

    const number = await db.transaction(async (tx) => {
      const locked = await proformasRepo.lockForUpdate(tx, id);
      if (!locked) throw ProformaErrors.notFound();
      if (locked.status !== ProformaStatus.Borrador) throw ProformaErrors.notDraft();

      const current = new Set(await proformasRepo.shipmentIdsIn(tx, id));
      if (current.size !== shipments.length || shipments.some((s) => !current.has(s.id))) {
        throw ProformaErrors.changed();
      }

      // Una proforma corregida conserva su numero; una nueva toma el siguiente.
      const assigned = locked.number ?? (await proformasRepo.takeNumbers(tx, 1))[0]!;

      /**
       * Cada tramite congela su factura CON su parte de los servicios de la
       * proforma (`allocateProformaInvoices`), y la proforma congela la SUMA de
       * esas facturas. Asi el total de la proforma es exactamente lo que suman sus
       * tramites, y pagarla es saldar cada uno.
       */
      await proformasRepo.setProformaLineAmounts(
        tx,
        extras
          .filter((l) => l.source === CostLineSource.Percentage)
          .map((l) => ({ id: l.id, amount: l.amount, realAmount: l.realAmount })),
      );
      const invoices = allocateProformaInvoices(
        shipments.map((s) => computeTotals(linesByShipment.get(s.id) ?? [])),
        computeTotals(extras),
        p.currency,
      );
      for (const [i, s] of shipments.entries()) {
        await proformasRepo.freezeShipmentInvoice(tx, s.id, invoices[i]!, session.userId, freightRate);
      }

      await proformasRepo.markApproved(tx, id, {
        number: assigned,
        exchangeRate,
        totals: sumInvoices(invoices),
        approvedBy: session.userId,
      });
      return assigned;
    });

    const formatted = formatProformaNumber(number);

    /**
     * Avance a cobro, DESPUES de la transaccion: lo hace `transitionsService` para
     * que la guarda RequiresInvoiceAmount se compruebe de verdad contra la factura
     * recien congelada y queden el evento y la notificacion del estado. En
     * Transporte no hay avance: se cobra en el mismo estado de facturacion.
     */
    if (payable && payable !== State.FacturacionEnProceso) {
      for (const s of shipments) {
        await transitionsService.transition(
          session,
          s.id,
          { state: payable, note: `Proforma ${formatted} aprobada.` },
          { skipPermission: true },
        );
      }
    }

    return { id, number: formatted };
  },

  /**
   * Aprueba varias. Cada una en su propia transaccion y en el orden pedido, asi
   * que los numeros salen en ese orden. Una que falla se reporta y no detiene a
   * las demas: el operador ve cuales salieron y por que no salio el resto.
   */
  async approveMany(session: Session, ids: readonly string[]): Promise<ApproveProformasResult> {
    const result: ApproveProformasResult = { approved: [], failed: [] };
    for (const id of [...new Set(ids)]) {
      try {
        result.approved.push(await this.approve(session, id));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        result.failed.push({ id, code: error.code, message: error.message });
      }
    }
    return result;
  },

  /**
   * ENVIAR A RUTA: pasa a "En ruta de entrega" los paquetes de las proformas que
   * esten en "En bodega preparando". Solo Paqueteria y solo pagadas, salvo que el
   * casillero este EXENTO de la retencion por pago (`paymentGateWaived`): entonces
   * basta con que este aprobada, y el resultado la marca `unpaid` para que la
   * pantalla lo advierta.
   *
   * Cada paquete avanza por la maquina de estados (`transitionsService`), sin
   * saltarse nada: queda su evento en el historial, se comprueba el permiso de
   * entregas y la guarda del pago confirmado (que para el exento se perdona y
   * queda escrita en el evento). Por eso uno que falla no frena a los demas: se
   * reporta y se sigue, igual que la aprobacion en bloque.
   */
  async dispatchMany(session: Session, ids: readonly string[]): Promise<DispatchProformasResult> {
    const result: DispatchProformasResult = { dispatched: [], failed: [] };
    for (const id of [...new Set(ids)]) {
      let number: string | null = null;
      try {
        const header = await loadHeader(id);
        const p = header.proforma;
        number = p.number === null ? null : formatProformaNumber(p.number);
        if (p.flow !== Flow.Paqueteria) throw ProformaErrors.notDispatchableFlow();
        const unpaid = p.status === ProformaStatus.Aprobada;
        const waived = paymentGateWaived(p.flow, header.clientPaymentGateExempt);
        if (p.status !== ProformaStatus.Pagada && !(unpaid && waived)) throw ProformaErrors.notPaid();
        const ready = (await proformasRepo.shipmentsOf(id)).filter((s) => s.state === State.EnBodegaPendientePago);
        if (ready.length === 0) throw ProformaErrors.nothingToDispatch();

        const moved: string[] = [];
        for (const s of ready) {
          try {
            await transitionsService.transition(session, s.id, {
              state: State.EnRutaEntrega,
              note: `Proforma ${number} enviada a ruta.`,
            });
            moved.push(s.code);
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            result.failed.push({ id, number, shipmentCode: s.code, message: error.message });
          }
        }
        if (moved.length > 0) result.dispatched.push({ id, number, shipmentCodes: moved, unpaid });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        result.failed.push({ id, number, shipmentCode: null, message: error.message });
      }
    }
    return result;
  },

  /**
   * Corrige una proforma aprobada y no pagada: vuelve a borrador CONSERVANDO SU
   * NUMERO y sus tramites vuelven a "Facturacion en proceso" con la factura
   * descongelada.
   *
   * Cualquier pago confirmado o en validacion la bloquea: el cliente ya pago (o
   * dice haber pagado) contra este monto, y cambiarlo dejaria ese pago apuntando
   * a una cifra que ya no existe. Lo pagado se corrige por la via contable.
   */
  async correct(session: Session, id: string, input: CorrectProformaInput) {
    const header = await loadHeader(id);
    const p = header.proforma;
    if (p.status !== ProformaStatus.Aprobada || p.number === null) throw ProformaErrors.notCorrectable();

    const shipments = await proformasRepo.shipmentsOf(id);
    const payable = payableStateOf(p.flow);
    for (const s of shipments) {
      // Solo se deshace lo que la aprobacion hizo: un tramite que ya siguio de
      // largo (salio a ruta, entro a aduana) ya no esta en el estado de cobro.
      if (s.state !== State.FacturacionEnProceso && s.state !== payable) {
        throw ProformaErrors.notCorrectable();
      }
      const payments = await paymentsRepo.settlementView(s.id);
      if (payments.some((x) => x.status === PaymentStatus.Confirmado || x.status === PaymentStatus.Pendiente)) {
        throw ProformaErrors.hasPayments();
      }
    }

    await db.transaction(async (tx) => {
      const locked = await proformasRepo.lockForUpdate(tx, id);
      if (!locked || locked.status !== ProformaStatus.Aprobada) throw ProformaErrors.changed();
      await proformasRepo.markDraftAgain(tx, id);
      for (const s of shipments) await proformasRepo.releaseShipmentInvoice(tx, s.id);
    });

    /**
     * Vuelta a facturacion, fuera de la maquina (que no retrocede). El prefijo de
     * correccion marca el asiento como enmienda: el historial no puede decir que
     * el tramite "avanzo" a facturacion.
     */
    const note = `${CORRECTION_NOTE_PREFIX}proforma ${formatProformaNumber(p.number)} devuelta a borrador. ${input.note}`;
    for (const s of shipments) {
      if (s.state !== State.FacturacionEnProceso) {
        await shipmentsRepo.transition(s.id, State.FacturacionEnProceso, session.userId, note);
      }
    }
    return this.get(id);
  },

  /**
   * Mueve un tramite de un borrador a otro, o a uno nuevo (`toProformaId: null`).
   * El borrador de origen se borra si quedo vacio y nunca se numero.
   */
  async moveShipment(
    session: Session,
    fromId: string,
    shipmentId: string,
    input: MoveProformaShipmentInput,
  ): Promise<ProformaDetailDto> {
    const from = (await loadDraft(fromId)).proforma;
    const shipment = (await proformasRepo.shipmentsOf(fromId)).find((s) => s.id === shipmentId);
    if (!shipment || shipment.clientId === null) throw ProformaErrors.shipmentNotInProforma();

    let targetId: string;
    if (input.toProformaId === null) {
      const created = await proformasRepo.createDraft(
        { clientId: from.clientId, flow: from.flow, currency: from.currency },
        session.userId,
      );
      targetId = created.id;
    } else {
      if (input.toProformaId === fromId) throw ProformaErrors.sameProforma();
      const target = await proformasRepo.findById(input.toProformaId);
      if (!target) throw ProformaErrors.notFound();
      const block = joinBlockFor(target, { clientId: shipment.clientId, shipmentType: shipment.shipmentType });
      if (block) throw ProformaErrors.joinBlocked(PROFORMA_JOIN_BLOCK_MESSAGES[block]);
      targetId = target.id;
    }

    await proformasRepo.attachShipment(targetId, shipmentId, session.userId);
    await proformasRepo.deleteIfEmptyDraft(fromId);
    return this.get(targetId);
  },

  /**
   * Reasigna un paquete del borrador a otro cliente (objetivo 7). Es la misma
   * reasignacion de dueño del tramite, con sus candados; lo que la hace de
   * proformas es que el paquete sale de este borrador y entra al del cliente
   * nuevo con el flete de SU tarifa (`proformaDraftsService.onOwnerChanged`).
   */
  async reassignShipment(
    session: Session,
    fromId: string,
    shipmentId: string,
    input: AssignShipmentOwnerInput,
  ) {
    await loadDraft(fromId);
    const shipment = (await proformasRepo.shipmentsOf(fromId)).find((s) => s.id === shipmentId);
    if (!shipment) throw ProformaErrors.shipmentNotInProforma();
    return shipmentsService.assignOwner(session, shipmentId, input);
  },

  async update(id: string, input: UpdateProformaInput): Promise<ProformaDetailDto> {
    await loadHeader(id);
    await proformasRepo.setElectronicInvoiceNumber(id, input.electronicInvoiceNumber);
    return this.get(id);
  },

  /** Modelo del documento (HTML y CSV). */
  async document(id: string): Promise<ProformaDocument> {
    const header = await loadHeader(id);
    const p = header.proforma;
    const [client, shipments, shipmentLines, proformaLines] = await Promise.all([
      proformasRepo.documentClient(p.clientId),
      proformasRepo.shipmentsOf(id),
      proformasRepo.shipmentLinesOf([id]),
      proformasRepo.proformaLinesOf([id]),
    ]);
    if (!client) throw ProformaErrors.notFound();
    const currency = p.currency;
    const extras = isProformaEditable(p.status) ? withLivePercentages(proformaLines, shipmentLines) : proformaLines;
    /**
     * La comision del cobro con tarjeta se asienta en cada tramite (asi su factura
     * sube junto con su abono), pero para el cliente es UNA linea de la proforma
     * (decision P1): se saca de los paquetes y se imprime con los servicios de la
     * proforma, sumada.
     */
    const surchargeLines = shipmentLines.filter((l) => l.paymentId !== null);
    const linesByShipment = groupBy(
      shipmentLines.filter((l) => l.paymentId === null),
      (l) => l.shipmentId,
    );
    const surchargeTotal = roundMoney(
      surchargeLines.reduce((acc, l) => acc + convertMoney(l.amount, l.currency, currency, l.exchangeRate), 0),
      currency,
    );
    const surchargeExtra: DocumentLine[] =
      surchargeLines.length > 0
        ? [{ label: CARD_SURCHARGE_LABEL, electronicInvoiceCode: null, amount: surchargeTotal }]
        : [];

    const items: DocumentItem[] = shipments.map((s) => {
      const lines = linesByShipment.get(s.id) ?? [];
      const breakdown = breakdownByCategory(lines, currency);
      return {
        code: s.code,
        awb: s.hawb ?? s.tracking,
        tracking: s.tracking,
        description: s.description,
        weightKg: displayedWeightKg(s.weightKg, s.rateKind),
        freight: breakdown.flete,
        // "Otros / Permisos" junta lo trasladado que no es impuesto con los
        // honorarios propios: para el cliente es lo que se cobra aparte.
        others: roundMoney(breakdown.otros + breakdown.propio, currency),
        taxes: breakdown.impuestos,
        total: totalIn(computeTotals(lines), currency),
        lines: lines.map((l) => toDocumentLine(l, currency)),
      };
    });

    return {
      number: p.number === null ? null : formatProformaNumber(p.number),
      status: p.status,
      currency,
      exchangeRate: p.exchangeRate ?? (await currentRate()),
      issuedAt: (p.approvedAt ?? new Date()).toISOString(),
      electronicInvoiceNumber: p.electronicInvoiceNumber,
      client: {
        name: client.name,
        idNumber: client.idNumber,
        phone: client.phone,
        address: formatAddress(client),
        email: client.email,
      },
      items,
      extras: [...extras.map((l) => toDocumentLine(l, currency)), ...surchargeExtra],
      totals: totalsOf(p, [...shipmentLines, ...extras]),
    };
  },

  async counter(): Promise<ProformaCounterDto> {
    const [nextNumber, lastIssued] = await Promise.all([
      proformasRepo.nextNumber(),
      proformasRepo.lastIssuedNumber(),
    ]);
    return { nextNumber, lastIssued };
  },

  /**
   * Fija el numero de la proxima proforma. No puede quedar en o por debajo del
   * ultimo emitido: repetiria un numero que un cliente ya tiene en la mano.
   */
  async setCounter(input: SetProformaCounterInput): Promise<ProformaCounterDto> {
    const lastIssued = await proformasRepo.lastIssuedNumber();
    if (lastIssued !== null && input.nextNumber <= lastIssued) {
      throw ProformaErrors.counterBelowIssued(lastIssued);
    }
    await proformasRepo.setNextNumber(input.nextNumber);
    return this.counter();
  },
};
