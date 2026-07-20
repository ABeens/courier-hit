/**
 * Reglas de negocio de los costos de un tramite (docs/06-modulo-administrativo.md §3.3).
 *
 * Cuatro decisiones que viven aqui y en ningun otro lado:
 *
 * 1. EL PERMISO SALE DE LA MAQUINA DE ESTADOS. Cargar costos es, literalmente,
 *    el paso "Facturacion en proceso" de cada flow: el permiso se lee de ahi
 *    (`permissionFor`) en vez de repetirse. Asi Agenciamiento exige
 *    costs.tramite.manage y los demas costs.manage, sin listas paralelas.
 * 2. LOS PORCENTAJES LOS CALCULA LA API. El cliente manda el porcentaje; el
 *    importe lo resuelve el servidor sobre la base de las lineas que NO son
 *    porcentaje. Un porcentaje que llegue con importe se ignora.
 * 3. LA TASA LA DIGITA EL OPERADOR. El BCCR solo SUGIERE (`exchangeRateProvider`);
 *    lo que se guarda en cada linea es lo que vino en el cuerpo (regla M5).
 * 4. APROBAR CONGELA Y AVANZA. Al aprobar se totaliza en ambas monedas, se fija
 *    el monto de factura en el tramite y este pasa a "En bodega - Pendiente pago"
 *    (que es justo lo que exige Condition.RequiresInvoiceAmount). Desde ahi las
 *    lineas ya no se editan.
 */
import {
  CostLineSource,
  Currency,
  Flow,
  ServiceKind,
  State,
  applyPercentage,
  can,
  canTransition,
  computeTotals,
  flowForType,
  percentageBase,
  permissionFor,
  roundMoney,
} from '@courier/shared';
import type {
  CostLineDto,
  CostLineInput,
  SaveShipmentCostsInput,
  Session,
  ShipmentCostsDto,
  SuggestedCostLine,
} from '@courier/shared';
import { AuthErrors, CostErrors, ShipmentErrors } from '../../core/errors';
import { clientsRepo } from '../clients/clients.repo';
import { costServicesRepo } from '../cost-services/cost-services.repo';
import { shipmentsRepo } from '../shipments/shipments.repo';
import { transitionsService } from '../shipments/transitions.service';
import { costsRepo } from './costs.repo';
import { exchangeRateProvider } from './exchange-rate';

/** Fila del tramite tal como la devuelve el repo de tramites. */
type ShipmentRow = NonNullable<Awaited<ReturnType<typeof shipmentsRepo.findById>>>;

/**
 * Permiso para cargar costos de ese flow. Se DERIVA del step de facturacion de la
 * maquina de estados: la matriz de permisos vive en un solo sitio.
 */
function costPermissionFor(flow: Flow) {
  const permission = permissionFor(flow, State.FacturacionEnProceso);
  if (!permission) throw CostErrors.notBillable();
  return permission;
}

/** 403 si el rol de la sesion no puede cargar costos de ese tramite. */
function assertCanCost(session: Session, row: ShipmentRow): void {
  if (!can(session.role, costPermissionFor(flowForType(row.shipmentType)))) {
    throw AuthErrors.forbidden();
  }
}

/** Familia del catalogo que aplica a ese tramite. */
function serviceKindFor(flow: Flow): ServiceKind {
  return flow === Flow.Paqueteria ? ServiceKind.Paqueteria : ServiceKind.TransporteAgenciamiento;
}

/** Fila de BD -> DTO de la API (fechas en ISO/UTC). */
function toLineDto(row: Awaited<ReturnType<typeof costsRepo.listLines>>[number]): CostLineDto {
  return {
    id: row.id,
    costServiceId: row.costServiceId,
    label: row.label,
    source: row.source,
    percentage: row.percentage,
    amount: row.amount,
    currency: row.currency,
    exchangeRate: row.exchangeRate,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Sugerencias al abrir la pantalla: el flete calculado (solo Paqueteria) y los
 * servicios habilitados del catalogo que aplican al tipo de tramite.
 *
 * El flete es peso x precio por kg de la TARIFA DEL CLIENTE. Si el tramite aun no
 * tiene peso, o el casillero quedo sin tarifa, simplemente no se sugiere: el
 * operador puede cargar la linea a mano.
 */
async function buildSuggestions(row: ShipmentRow): Promise<SuggestedCostLine[]> {
  const flow = flowForType(row.shipmentType);
  const suggestions: SuggestedCostLine[] = [];

  if (flow === Flow.Paqueteria && row.weightKg) {
    const rate = await clientsRepo.rateFor(row.clientId);
    if (rate) {
      suggestions.push({
        costServiceId: null,
        label: `Flete (${rate.rateName})`,
        source: CostLineSource.Freight,
        percentage: null,
        amount: roundMoney(row.weightKg * rate.pricePerKg, rate.currency),
        currency: rate.currency,
        detail: `${row.weightKg} kg × ${rate.pricePerKg} ${rate.currency}/kg`,
      });
    }
  }

  const services = await costServicesRepo.list({ kind: serviceKindFor(flow), enabled: true });
  for (const service of services) {
    const isPercentage = service.valueType === 'percentage';
    suggestions.push({
      costServiceId: service.id,
      label: service.name,
      source: isPercentage ? CostLineSource.Percentage : CostLineSource.Service,
      percentage: isPercentage ? service.defaultValue : null,
      amount: isPercentage ? null : service.defaultValue,
      // Paqueteria se cotiza en dolares; en Transporte/Agenciamiento el catalogo
      // es manual y sin moneda, asi que se propone colones y el operador decide.
      currency: service.currency ?? (flow === Flow.Paqueteria ? Currency.USD : Currency.CRC),
      detail: isPercentage && service.defaultValue !== null ? `${service.defaultValue}% del subtotal` : null,
    });
  }

  return suggestions;
}

/**
 * Resuelve el juego completo de lineas a guardar. Dos pasadas, en este orden:
 * primero las que tienen importe propio, luego los porcentajes sobre esa base.
 * Un porcentaje NUNCA se calcula sobre otro porcentaje (ver `percentageBase`).
 */
function resolveLines(input: CostLineInput[]): {
  costServiceId: string | null;
  label: string;
  source: CostLineSource;
  percentage: number | null;
  amount: number;
  currency: Currency;
  exchangeRate: number;
}[] {
  const base = input
    .filter((l) => l.source !== CostLineSource.Percentage)
    .map((l) => ({
      costServiceId: l.costServiceId ?? null,
      label: l.label,
      source: l.source,
      percentage: null,
      // El esquema Zod ya garantizo que las lineas no-porcentaje traen importe.
      amount: roundMoney(l.amount!, l.currency),
      currency: l.currency,
      exchangeRate: l.exchangeRate,
    }));

  const percentages = input
    .filter((l) => l.source === CostLineSource.Percentage)
    .map((l) => {
      const pct = l.percentage!; // garantizado por el esquema Zod
      return {
        costServiceId: l.costServiceId ?? null,
        label: l.label,
        source: CostLineSource.Percentage,
        percentage: pct,
        amount: applyPercentage(percentageBase(base, l.currency), pct, l.currency),
        currency: l.currency,
        exchangeRate: l.exchangeRate,
      };
    });

  return [...base, ...percentages];
}

export const costsService = {
  /** Tramite + permiso, comun a todas las operaciones del modulo. */
  async loadShipment(session: Session, shipmentId: string): Promise<ShipmentRow> {
    const row = await shipmentsRepo.findById(shipmentId);
    if (!row) throw ShipmentErrors.notFound();
    assertCanCost(session, row);
    return row;
  },

  /** Lineas guardadas + sugerencias + totales + tasa sugerida del dia. */
  async get(session: Session, shipmentId: string): Promise<ShipmentCostsDto> {
    const shipment = await this.loadShipment(session, shipmentId);
    const [rows, approval, suggestion] = await Promise.all([
      costsRepo.listLines(shipmentId),
      costsRepo.approval(shipmentId),
      exchangeRateProvider.suggest(),
    ]);

    const approved = approval?.approvedAt != null;
    return {
      shipmentId,
      lines: rows.map(toLineDto),
      // Aprobado = congelado: no tiene sentido sugerir nada mas.
      suggestions: approved ? [] : await buildSuggestions(shipment),
      totals: computeTotals(rows),
      approved,
      approvedAt: approval?.approvedAt?.toISOString() ?? null,
      approvedByName: approval?.approvedByName ?? null,
      suggestedExchangeRate: suggestion.rate,
    };
  },

  /** Reemplaza el juego de lineas. Bloqueado una vez aprobado. */
  async save(
    session: Session,
    shipmentId: string,
    input: SaveShipmentCostsInput,
  ): Promise<ShipmentCostsDto> {
    await this.loadShipment(session, shipmentId);
    const approval = await costsRepo.approval(shipmentId);
    if (approval?.approvedAt) throw CostErrors.alreadyApproved();

    const lines = resolveLines(input.lines).map((l) => ({
      ...l,
      shipmentId,
      createdBy: session.userId,
    }));
    await costsRepo.replaceLines(shipmentId, lines);
    return this.get(session, shipmentId);
  },

  /**
   * Aprueba: congela el total en ambas monedas y avanza a "En bodega - Pendiente
   * pago". El avance es la consecuencia del acto de aprobar, asi que basta el
   * permiso de costos; no se vuelve a exigir el del estado destino.
   *
   * Solo se aprueba desde "Facturacion en proceso": es el unico punto del flujo
   * donde ese avance es legal, y aprobar sin poder avanzar dejaria el tramite con
   * una factura congelada y el flujo detenido.
   */
  async approve(session: Session, shipmentId: string): Promise<ShipmentCostsDto> {
    const shipment = await this.loadShipment(session, shipmentId);
    const approval = await costsRepo.approval(shipmentId);
    if (approval?.approvedAt) throw CostErrors.alreadyApproved();

    const rows = await costsRepo.listLines(shipmentId);
    if (rows.length === 0) throw CostErrors.noLines();

    const flow = flowForType(shipment.shipmentType);
    if (shipment.state !== State.FacturacionEnProceso) throw CostErrors.notBillableState();
    if (!canTransition(flow, shipment.state, State.EnBodegaPendientePago)) {
      throw CostErrors.notBillableState();
    }

    const totals = computeTotals(rows);
    await costsRepo.freezeInvoice(shipmentId, totals, session.userId);

    /**
     * El avance lo hace `transitionsService` y no el repo directamente: asi la
     * guarda Condition.RequiresInvoiceAmount se comprueba de verdad (contra el
     * total que se acaba de congelar) y el correo del step sale solo.
     *
     * `skipPermission`: avanzar es la consecuencia de aprobar, y para aprobar ya
     * se exigio el permiso de costos arriba. Volver a pedir el del estado destino
     * dejaria a Operativo aprobando una factura que no puede cerrar.
     */
    await transitionsService.transition(
      session,
      shipmentId,
      { state: State.EnBodegaPendientePago, note: 'Costos aprobados.' },
      { skipPermission: true },
    );

    return this.get(session, shipmentId);
  },

  /** Tasa sugerida del dia (para precargar el formulario). */
  async suggestedRate() {
    return exchangeRateProvider.suggest();
  },
};
