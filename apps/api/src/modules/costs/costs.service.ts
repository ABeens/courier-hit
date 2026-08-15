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
 * 3. LA TASA LA FIJA EL ADMINISTRADOR EN CONFIGURACIÓN. Es un valor general del
 *    sistema, no un dato del tramite: solo `exchange_rate.write` decide su valor
 *    y al resto se le impone la vigente (`resolveExchangeRate`). Lo que publica
 *    el BCCR viaja al lado como referencia y nunca se guarda solo. Lo que queda
 *    en la BD sigue siendo un snapshot por linea (regla M5); lo que cambia es
 *    quien elige ese numero y donde.
 * 4. APROBAR CONGELA Y AVANZA. Al aprobar se totaliza en ambas monedas, se fija
 *    el monto de factura en el tramite y este pasa a "En bodega - Pendiente pago"
 *    (que es justo lo que exige Condition.RequiresInvoiceAmount). Desde ahi las
 *    lineas ya no se editan.
 */
import {
  CostCategory,
  CostLineSource,
  Currency,
  Flow,
  ServiceKind,
  State,
  PaymentStatus,
  applyPercentage,
  can,
  canSetExchangeRate,
  canTransition,
  categoryForLine,
  computeTotals,
  costLineExchangeRateSchema,
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
import { paymentsRepo } from '../payments/payments.repo';
import { shipmentsRepo } from '../shipments/shipments.repo';
import { transitionsService } from '../shipments/transitions.service';
import { exchangeRateReference } from '../settings/bccr-reference';
import { settingsRepo } from '../settings/settings.repo';
import { costsRepo } from './costs.repo';

/**
 * Fila del tramite tal como la devuelve el repo de tramites, con el casillero YA
 * garantizado. Todo este modulo cotiza contra la tarifa del dueño, asi que un
 * tramite sin dueño no entra: lo filtra `loadShipment` en la puerta y de ahi
 * hacia dentro `clientId` es un string, no un hueco que revisar en cada calculo.
 */
type ShipmentRow = NonNullable<Awaited<ReturnType<typeof shipmentsRepo.findById>>> & {
  clientId: string;
};

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
    category: row.category,
    electronicInvoiceCode: row.electronicInvoiceCode,
    source: row.source,
    percentage: row.percentage,
    amount: row.amount,
    currency: row.currency,
    exchangeRate: row.exchangeRate,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Linea de flete de Paqueteria: peso x precio por kg de la TARIFA EFECTIVA del
 * casillero (la asignada o, si quedo sin ninguna, la por defecto; lo resuelve
 * `clientsRepo.rateFor`).
 *
 * Se marca `auto: true` porque NO es una opcion del catalogo: es el cobro base
 * del servicio y entra solo en la factura. Null solo si el tramite todavia no
 * tiene peso (sin peso no hay flete que calcular) o si no hubo tarifa alguna.
 */
async function buildFreight(
  row: ShipmentRow,
): Promise<(SuggestedCostLine & { amount: number }) | null> {
  if (!row.weightKg) return null;

  const rate = await clientsRepo.rateFor(row.clientId);
  if (!rate) return null;

  const detail = `${row.weightKg} kg × ${rate.pricePerKg} ${rate.currency}/kg`;
  return {
    costServiceId: null,
    label: `Flete (${rate.rateName})`,
    category: CostCategory.Flete,
    source: CostLineSource.Freight,
    percentage: null,
    amount: roundMoney(row.weightKg * rate.pricePerKg, rate.currency),
    currency: rate.currency,
    detail: rate.isFallback ? `${detail} · tarifa por defecto` : detail,
    auto: true,
  };
}

/**
 * Sugerencias al abrir la pantalla: el flete calculado (solo Paqueteria, y va
 * primero porque se aplica solo) y los servicios habilitados del catalogo que
 * aplican al tipo de tramite, que el operador agrega si corresponden.
 */
async function buildSuggestions(row: ShipmentRow): Promise<SuggestedCostLine[]> {
  const flow = flowForType(row.shipmentType);
  const suggestions: SuggestedCostLine[] = [];

  if (flow === Flow.Paqueteria) {
    const freight = await buildFreight(row);
    if (freight) suggestions.push(freight);
  }

  const services = await costServicesRepo.list({ kind: serviceKindFor(flow), enabled: true });
  for (const service of services) {
    const isPercentage = service.valueType === 'percentage';
    suggestions.push({
      costServiceId: service.id,
      label: service.name,
      category: service.category,
      source: isPercentage ? CostLineSource.Percentage : CostLineSource.Service,
      percentage: isPercentage ? service.defaultValue : null,
      amount: isPercentage ? null : service.defaultValue,
      // Paqueteria se cotiza en dolares; en Transporte/Agenciamiento el catalogo
      // es manual y sin moneda, asi que se propone colones y el operador decide.
      currency: service.currency ?? (flow === Flow.Paqueteria ? Currency.USD : Currency.CRC),
      detail: isPercentage && service.defaultValue !== null ? `${service.defaultValue}% del subtotal` : null,
      auto: false,
    });
  }

  return suggestions;
}

/**
 * Garantiza el flete en el juego de lineas de Paqueteria: si el cuerpo no trae
 * ninguna linea de flete, se antepone la calculada desde la tarifa del casillero.
 *
 * Es la contraparte en servidor de que el flete sea un cobro fijo: el cliente no
 * decide si se cobra el peso, solo puede AJUSTAR el importe (linea Freight que si
 * viene se respeta tal cual). Se reutiliza la tasa de cambio que el operador ya
 * digito en el resto de las lineas (regla M5: la tasa no la inventa el servidor),
 * asi que un cuerpo vacio se guarda vacio.
 */
async function withFreight(row: ShipmentRow, input: CostLineInput[]): Promise<CostLineInput[]> {
  if (flowForType(row.shipmentType) !== Flow.Paqueteria) return input;
  if (input.length === 0) return input;
  if (input.some((l) => l.source === CostLineSource.Freight)) return input;

  const freight = await buildFreight(row);
  if (!freight) return input;

  return [
    {
      costServiceId: null,
      label: freight.label,
      source: CostLineSource.Freight,
      percentage: null,
      amount: freight.amount,
      currency: freight.currency,
      exchangeRate: input[0]!.exchangeRate,
    },
    ...input,
  ];
}

/**
 * Tasa que se va a guardar en TODAS las lineas del tramite.
 *
 * La tasa es un valor general del sistema: solo quien tiene `exchange_rate.write`
 * elige su valor, y lo hace en Configuración. Al resto se le IGNORA la que venga
 * en el cuerpo y se le impone la vigente, en este orden:
 *   1. la que ya quedo guardada en el tramite (una factura en curso no se
 *      recotiza sola porque el administrador haya movido la tasa entre dos
 *      guardados), y
 *   2. si es la primera carga, la tasa global del sistema.
 * El BCCR NO entra en esta cadena: es referencia para decidir la global, no un
 * valor con el que se guarde un monto. Sin ninguna de las dos no se guarda: una
 * linea sin tasa valida rompe la regla M5 y dejaria la factura sin testigo de
 * conversion.
 *
 * Se ignora en silencio en vez de responder 403 a proposito: el cuerpo lleva la
 * tasa en cada linea, asi que un guardado normal de quien no puede fijarla la
 * reenvia tal como se la mostro la pantalla. Fallar ahi seria castigar el caso
 * corriente; lo que importa es que ese valor no mande.
 */
async function resolveExchangeRate(
  session: Session,
  shipmentId: string,
  input: CostLineInput[],
): Promise<number> {
  // Con permiso manda lo digitado; el esquema Zod ya valido rango y signo. La
  // pantalla se lo precarga con la global, asi que lo normal es que sean iguales:
  // este es el caso del ajuste puntual sobre un tramite.
  if (canSetExchangeRate(session.role)) return input[0]!.exchangeRate;

  const [saved] = await costsRepo.listLines(shipmentId);
  const current = saved?.exchangeRate ?? (await settingsRepo.currentExchangeRate());

  // Mismo rango que exige el cuerpo: una tasa impuesta por el servidor no puede
  // entrar por una puerta con menos validacion que la que digita el admin.
  const checked = costLineExchangeRateSchema.safeParse(current);
  if (!checked.success) throw CostErrors.noExchangeRate();
  return checked.data;
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
    if (row.discardedAt !== null) throw ShipmentErrors.discarded();
    /**
     * Sin dueño no hay a quien cotizar: el flete sale de la tarifa por kilo del
     * casillero (`clientsRepo.rateFor`) y la factura se le presenta a alguien.
     * Un paquete desconocido espera en la sala de control hasta que se sepa de
     * quien es; entonces entra a costos como cualquier otro.
     */
    if (row.clientId === null) throw ShipmentErrors.unassigned();
    assertCanCost(session, { ...row, clientId: row.clientId });
    return { ...row, clientId: row.clientId };
  },

  /** Lineas guardadas + sugerencias + totales + tasa vigente y referencia. */
  async get(session: Session, shipmentId: string): Promise<ShipmentCostsDto> {
    const shipment = await this.loadShipment(session, shipmentId);
    const [rows, approval, globalRate, reference] = await Promise.all([
      costsRepo.listLines(shipmentId),
      costsRepo.approval(shipmentId),
      settingsRepo.currentExchangeRate(),
      // La referencia del BCCR solo le sirve a quien puede cambiar la tasa; al
      // resto le sale el campo bloqueado. Pedirsela igual metería la latencia de
      // un servicio externo en cada apertura de la pantalla, a cambio de un dato
      // que esa persona no puede usar.
      canSetExchangeRate(session.role) ? exchangeRateReference.suggest() : null,
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
      globalExchangeRate: globalRate,
      referenceExchangeRate: reference?.rate ?? null,
    };
  },

  /** Reemplaza el juego de lineas. Bloqueado una vez aprobado. */
  async save(
    session: Session,
    shipmentId: string,
    input: SaveShipmentCostsInput,
  ): Promise<ShipmentCostsDto> {
    const shipment = await this.loadShipment(session, shipmentId);
    const approval = await costsRepo.approval(shipmentId);
    if (approval?.approvedAt) throw CostErrors.alreadyApproved();

    /**
     * La tasa se resuelve UNA vez y se estampa en todo el juego: quien no puede
     * fijarla no la mueve, y de paso el trámite no puede quedar con dos tasas
     * distintas entre sus líneas. Sin líneas no hay nada que cotizar (guardar
     * vacío es borrar), así que ahí ni se consulta.
     */
    let inputLines = input.lines;
    if (inputLines.length > 0) {
      const rate = await resolveExchangeRate(session, shipmentId, inputLines);
      inputLines = inputLines.map((l) => ({ ...l, exchangeRate: rate }));
    }

    const resolved = resolveLines(await withFreight(shipment, inputLines));

    /**
     * Categoria y COD SIS FE se copian del catalogo AQUI, al guardar, y no se
     * leen del catalogo al reportar. Es la misma regla que ya rige la etiqueta y
     * el monto: la linea es un SNAPSHOT. Si el administrador reclasifica manana
     * "Permiso de importacion" de trasladado a honorario propio, el margen de las
     * facturas ya emitidas no se puede mover solo.
     *
     * La linea de flete no consulta nada: `categoryForLine` le impone
     * `CostCategory.Flete` porque no sale de ningun servicio del catalogo.
     */
    const serviceIds = [...new Set(resolved.map((l) => l.costServiceId).filter((id) => id !== null))];
    const services = await costServicesRepo.listByIds(serviceIds);
    const byId = new Map(services.map((s) => [s.id, s]));

    const lines = resolved.map((l) => {
      const service = l.costServiceId ? byId.get(l.costServiceId) : undefined;
      return {
        ...l,
        category: categoryForLine(l.source, service?.category),
        electronicInvoiceCode: service?.electronicInvoiceCode ?? null,
        shipmentId,
        createdBy: session.userId,
      };
    });

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
    /**
     * La tarifa de transporte internacional se congela junto al total, y solo en
     * Paqueteria: es el unico flujo cuyo reporte la usa (campo 21). Se lee de
     * Configuración en este instante, que es el unico en que la factura de este
     * paquete y esa tarifa coexisten.
     *
     * Que no haya tarifa fijada NO impide aprobar: la factura del cliente no
     * depende de ella. El paquete queda sin costo de flete en el reporte, que es
     * la verdad (nadie dijo cuanto costo) y no un cero que la disimule.
     */
    const freightRate =
      flow === Flow.Paqueteria ? await settingsRepo.currentFreightRate() : null;
    await costsRepo.freezeInvoice(shipmentId, totals, session.userId, freightRate);

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

  /**
   * Reversa una aprobacion: descongela la factura para que los costos se puedan
   * corregir y volver a aprobar. Es la accion que `ShipmentErrors
   * .weightLockedAfterInvoice` lleva pidiendo desde siempre ("Reversa los costos
   * del trámite para corregirlo") y que hasta ahora no existia, dejando sin
   * arreglo cualquier paquete facturado con el peso mal.
   *
   * NO toca el estado del tramite. Va aparte de `transitionsService.correct` a
   * proposito: son dos errores distintos (haber avanzado mal y haber cobrado mal)
   * y juntarlos obligaria a deshacer uno para arreglar el otro. El orden habitual
   * es corregir el estado primero y reversar despues, pero ninguno exige al otro.
   *
   * Dos guardas:
   *   ESTADO — espejo de `approve`: solo desde "Facturacion en proceso". Mas
   *     adelante el tramite ya se le mostro al cliente como cobrable, y borrarle
   *     la factura le dejaria el boton de pagar apuntando a nada. Volver primero
   *     el estado (con la correccion) es lo que hace segura la reversion.
   *   DINERO — con un pago confirmado, borrar la factura dejaria un abono contra
   *     algo que no existe. Los pendientes o rechazados no bloquean: aun no son
   *     dinero.
   */
  async reverse(session: Session, shipmentId: string): Promise<ShipmentCostsDto> {
    const shipment = await this.loadShipment(session, shipmentId);

    const approval = await costsRepo.approval(shipmentId);
    if (!approval?.approvedAt) throw CostErrors.notApproved();
    if (shipment.state !== State.FacturacionEnProceso) throw CostErrors.notReversibleState();

    const payments = await paymentsRepo.settlementView(shipmentId);
    if (payments.some((p) => p.status === PaymentStatus.Confirmado)) {
      throw CostErrors.settledCannotReverse();
    }

    await costsRepo.releaseInvoice(shipmentId);
    return this.get(session, shipmentId);
  },
};
