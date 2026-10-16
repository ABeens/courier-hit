/**
 * La PROFORMA como entidad: el grupo de paquetes o tramites de un cliente que se
 * revisa, se aprueba, se cobra y (en Paqueteria) se entrega como una unidad.
 * Especificacion: docs/proformas-cambios.html.
 *
 * Reemplaza al modelo anterior, en el que la proforma era un documento que se
 * armaba al pedirlo, uno por tramite. Aqui vive lo que decide QUE entra en una
 * proforma y CUANDO se puede tocar; los contratos de la API estan en `dto.ts`.
 *
 * Cuatro reglas del negocio que definen la entidad:
 *
 * 1. TODA PROFORMA NACE EN BORRADOR y la aprueba una persona. El sistema arma el
 *    borrador y calcula el flete, pero nunca aprueba solo (la facturacion
 *    automatica anterior se retiro).
 * 2. UN CLIENTE, UN FLUJO, UNA MONEDA. Monedas distintas, proformas distintas, y
 *    no se mezclan tipos de tramite. Dentro de Transporte si se juntan aereo y
 *    maritimo: la frontera es el FLUJO, no el tipo. Paqueteria cobra siempre en
 *    dolares; Transporte y Agenciamiento eligen la moneda de cada proforma.
 * 3. SOLO PAQUETERIA AGRUPA SOLA. Todos los paquetes de un cliente caen en su
 *    borrador abierto mientras no se apruebe. Transporte y Agenciamiento van una
 *    proforma por tramite; juntarlos es una accion manual del operador.
 * 4. EL NUMERO SE ASIGNA AL APROBAR. Un borrador nuevo no consume consecutivo;
 *    uno que vuelve a borrador por una correccion conserva el suyo.
 */
import type { CostTotals } from '../costs/shipment-cost';
import { Currency, roundMoney } from '../money/currency';
import { defaultChargeCurrencyFor } from '../payments/payment';
import { splitAmount } from '../payments/surcharge';
import { Flow, flowForType } from '../workflow/shipment-type';
import type { ShipmentType } from '../workflow/shipment-type';

/** Estado de la proforma. Las claves son estables: alimentan el enum de Postgres. */
export enum ProformaStatus {
  /** Editable: se agregan, sacan y mueven paquetes, se corrigen pesos y costos. */
  Borrador = 'borrador',
  /** Numerada y congelada. El cliente ya la puede pagar. */
  Aprobada = 'aprobada',
  /** Los pagos confirmados cubren el total. Ya no se corrige. */
  Pagada = 'pagada',
}

/** Etiqueta de presentacion del estado. */
export const PROFORMA_STATUS_LABELS: Record<ProformaStatus, string> = {
  [ProformaStatus.Borrador]: 'Borrador',
  [ProformaStatus.Aprobada]: 'Aprobada',
  [ProformaStatus.Pagada]: 'Pagada',
};

/**
 * Etiqueta del estado en el portal del CLIENTE: a el una "aprobada" le dice lo
 * que tiene que hacer, que es pagarla.
 */
export const PROFORMA_CLIENT_STATUS_LABELS: Record<ProformaStatus, string> = {
  ...PROFORMA_STATUS_LABELS,
  [ProformaStatus.Aprobada]: 'Pendiente de pago',
};

/** Valores para el enum de la BD (Drizzle pgEnum), sin repetirlos. */
export const PROFORMA_STATUS_VALUES = Object.values(ProformaStatus) as [
  ProformaStatus,
  ...ProformaStatus[],
];

/** Solo el borrador admite cambios de contenido (regla 1). */
export function isProformaEditable(status: ProformaStatus): boolean {
  return status === ProformaStatus.Borrador;
}

/**
 * True si el peso de un paquete se puede corregir por estar en un BORRADOR,
 * aunque su estado ya no lo admita. Pasa con un paquete que ya se entrego y cuya
 * proforma se corrigio: la factura esta descongelada y el peso es justo lo que
 * hay que arreglar. Fuera de un borrador manda la ventana del estado.
 */
export function isWeightEditableInProforma(status: ProformaStatus | null | undefined): boolean {
  return status != null && isProformaEditable(status);
}

/**
 * True si el flujo arma sus borradores SOLO, juntando todo lo del cliente
 * (regla 3). En los demas cada tramite abre el suyo.
 */
export function groupsAutomatically(flow: Flow): boolean {
  return flow === Flow.Paqueteria;
}

/**
 * Moneda de la proforma: la moneda en que se COBRA. Es la misma que lee
 * `chargeCurrencyOf` para cada uno de sus tramites, y tiene que serlo: la
 * proforma es lo que el cliente paga, y un documento en una moneda cobrado en
 * otra obligaria a convertir para reconocer el propio cobro.
 *
 * Quien la decide depende del flujo:
 *   - PAQUETERIA: dolares, siempre. Sus costos son USD-only y su borrador
 *     acumula los paquetes del cliente solo; no hay nada que elegir.
 *   - TRANSPORTE Y AGENCIAMIENTO: la elige el operador al cargar los costos,
 *     mientras la proforma sea borrador. Nace con la que propone el catalogo de
 *     servicios del flujo (`proposedCurrency`).
 */
export function canChooseProformaCurrency(flow: Flow): boolean {
  return flow !== Flow.Paqueteria;
}

/** Monedas en las que se puede cobrar una proforma de ese flujo. */
export function allowedProformaCurrencies(flow: Flow): Currency[] {
  return canChooseProformaCurrency(flow) ? [Currency.CRC, Currency.USD] : [Currency.USD];
}

/**
 * Moneda con la que nace la proforma de un tramite. En Paqueteria es la unica
 * posible; en los demas flujos, la que propone su catalogo (`catalogCurrency`),
 * y si el catalogo no propone ninguna, la del flujo.
 */
export function initialProformaCurrency(shipmentType: ShipmentType, catalogCurrency: Currency | null): Currency {
  const fallback = defaultChargeCurrencyFor(shipmentType);
  if (!canChooseProformaCurrency(flowForType(shipmentType))) return fallback;
  return catalogCurrency ?? fallback;
}

/** Lo que identifica a una proforma para decidir si un tramite cabe en ella. */
export interface ProformaIdentity {
  clientId: string;
  flow: Flow;
  currency: Currency;
  status: ProformaStatus;
}

/**
 * Lo que identifica a un tramite para esa misma decision. `currency` es la de
 * la proforma de la que viene: al moverse se cobra en la del destino, y si fueran
 * distintas el operador primero cambia una de las dos.
 */
export interface ProformaCandidate {
  clientId: string;
  shipmentType: ShipmentType;
  currency: Currency;
}

/**
 * Por que un tramite NO puede entrar a una proforma. Enum y no booleano: la
 * pantalla tiene que poder decir cual regla lo impide, no solo que no se puede.
 */
export enum ProformaJoinBlock {
  NotDraft = 'not_draft',
  OtherClient = 'other_client',
  OtherFlow = 'other_flow',
  OtherCurrency = 'other_currency',
}

/** Mensaje de cada bloqueo, en el idioma del producto. */
export const PROFORMA_JOIN_BLOCK_MESSAGES: Record<ProformaJoinBlock, string> = {
  [ProformaJoinBlock.NotDraft]: 'Solo se pueden agregar trámites a una proforma en borrador.',
  [ProformaJoinBlock.OtherClient]: 'La proforma es de otro cliente.',
  [ProformaJoinBlock.OtherFlow]: 'No se pueden mezclar tipos de trámite en una proforma.',
  [ProformaJoinBlock.OtherCurrency]: 'La proforma se cobra en otra moneda.',
};

/**
 * La regla que impide que `candidate` entre a `proforma`, o `null` si puede.
 *
 * El orden importa solo para el mensaje: se reporta primero lo mas grueso (la
 * proforma ya no se edita), despues el dueño y al final el flujo y la moneda.
 * La moneda importa en Transporte y Agenciamiento, donde cada proforma elige la
 * suya: un tramite cotizado en colones no cambia de moneda por moverlo.
 */
export function joinBlockFor(
  proforma: ProformaIdentity,
  candidate: ProformaCandidate,
): ProformaJoinBlock | null {
  if (!isProformaEditable(proforma.status)) return ProformaJoinBlock.NotDraft;
  if (proforma.clientId !== candidate.clientId) return ProformaJoinBlock.OtherClient;
  if (proforma.flow !== flowForType(candidate.shipmentType)) return ProformaJoinBlock.OtherFlow;
  if (proforma.currency !== candidate.currency) return ProformaJoinBlock.OtherCurrency;
  return null;
}

/**
 * Numero de proforma: el CONSECUTIVO PELADO, sin prefijo y sin ceros delante
 * (1, 2, 3... o desde el valor inicial configurado). Asi estan numeradas las
 * proformas del material de referencia ("Factura proforma #951").
 *
 * No lleva el molde del consecutivo del tramite (`HSX` + 9 digitos) justamente
 * para que no se lea como uno: este numero es de la proforma, no del tramite.
 *
 * Es el punto UNICO del formato aunque hoy solo convierta a texto: lo imprime el
 * documento, lo muestran las pantallas y el reporte, y el dia que el negocio
 * quiera un ancho fijo o una serie por año se cambia aqui y no en cinco sitios.
 */
export function formatProformaNumber(sequence: number | string): string {
  return String(sequence);
}

/**
 * FACTURA DE CADA TRAMITE AL APROBAR: sus lineas propias MAS su parte de los
 * servicios cargados a la proforma entera.
 *
 * Por que se reparte. Los servicios de la proforma se cargan, se guardan y se
 * imprimen como de la proforma (decision D10). Pero el cobro, la guarda de salida
 * a ruta y el reporte preguntan "¿este TRAMITE esta pagado?" contra la factura de
 * cada tramite. Repartiendo aqui, la suma de las facturas de los tramites es
 * EXACTAMENTE el total de la proforma, y pagar la proforma es saldar cada uno.
 *
 * Como se reparte. En proporcion a lo que ya cobra cada tramite en la moneda de
 * la proforma, con `splitAmount` (el mayor resto se lleva los centimos sueltos):
 * ni se pierde ni se inventa un centimo. Cada moneda se reparte por separado con
 * los mismos pesos, porque cada una tiene su propio redondeo (M4).
 */
export function allocateProformaInvoices(
  own: readonly CostTotals[],
  extras: CostTotals,
  currency: Currency,
): CostTotals[] {
  const weights = own.map((t) => (currency === Currency.USD ? t.usd : t.crc));
  const usdShares = splitAmount(extras.usd, weights, Currency.USD);
  const crcShares = splitAmount(extras.crc, weights, Currency.CRC);
  return own.map((t, i) => ({
    usd: roundMoney(t.usd + (usdShares[i] ?? 0), Currency.USD),
    crc: roundMoney(t.crc + (crcShares[i] ?? 0), Currency.CRC),
  }));
}

/** Suma de facturas en las dos monedas, con el redondeo de cada una (M4). */
export function sumInvoices(invoices: readonly CostTotals[]): CostTotals {
  let usd = 0;
  let crc = 0;
  for (const t of invoices) {
    usd += t.usd;
    crc += t.crc;
  }
  return { usd: roundMoney(usd, Currency.USD), crc: roundMoney(crc, Currency.CRC) };
}

/**
 * Estado de ENTREGA de una proforma. No se guarda: se deriva de los estados de
 * sus tramites, que son los que de verdad cambian cuando se entrega algo. Asi no
 * hay una marca que pueda contradecir al paquete.
 *
 *   - Paqueteria (la unica que reparte, decision D4): Entregada cuando todos sus
 *     paquetes estan entregados; Entregada parcialmente si hay alguno; Pendiente
 *     si ninguno.
 *   - Transporte y Agenciamiento: Cerrada cuando todos sus tramites llegaron a
 *     Tramite finalizado. No hay entrega aparte que confirmar.
 *
 * "Entregada parcialmente" es un estado de la PROFORMA, no del paquete: los
 * paquetes siguen usando los estados de siempre (regla 10 del SOW).
 */
export enum ProformaDeliveryStatus {
  Pendiente = 'pendiente',
  EntregadaParcial = 'entregada_parcial',
  Entregada = 'entregada',
  Cerrada = 'cerrada',
}

export const PROFORMA_DELIVERY_STATUS_LABELS: Record<ProformaDeliveryStatus, string> = {
  [ProformaDeliveryStatus.Pendiente]: 'Pendiente de entrega',
  [ProformaDeliveryStatus.EntregadaParcial]: 'Entregada parcialmente',
  [ProformaDeliveryStatus.Entregada]: 'Entregada',
  [ProformaDeliveryStatus.Cerrada]: 'Cerrada',
};

/** Cuantos tramites tiene la proforma y en que punto estan. */
export interface ProformaDeliveryCounts {
  total: number;
  /** En "Entregado" (Paqueteria). */
  delivered: number;
  /** En "Tramite finalizado" (Transporte y Agenciamiento). */
  finished: number;
}

export function proformaDeliveryStatus(flow: Flow, counts: ProformaDeliveryCounts): ProformaDeliveryStatus {
  if (counts.total === 0) return ProformaDeliveryStatus.Pendiente;
  if (flow !== Flow.Paqueteria) {
    return counts.finished === counts.total ? ProformaDeliveryStatus.Cerrada : ProformaDeliveryStatus.Pendiente;
  }
  if (counts.delivered === counts.total) return ProformaDeliveryStatus.Entregada;
  if (counts.delivered > 0) return ProformaDeliveryStatus.EntregadaParcial;
  return ProformaDeliveryStatus.Pendiente;
}
