/**
 * Servicio de costo: entrada del catalogo de conceptos que el administrador puede
 * cargar sobre los tramites, sea de Transporte y Agenciamiento o de Paqueteria.
 * Fuente: docs/manuales/flujo.md L1-20 ("Administracion de Servicios para Costos
 * de Transporte y Agenciamiento" + "tarifas fijas").
 *
 * Ejemplos del manual:
 *   - "Permisos de Importacion: 10%"  -> Percentage, defaultValue 10
 *   - "Asesoria de Compra por Internet" (valor manual) -> Manual, defaultValue null
 *   - "Impuesto de aduana" (valor manual)              -> Manual, defaultValue null
 *
 * Las claves (valor del enum) son estables: alimentan un enum de Postgres.
 */
import { Currency } from '../money/currency';

/**
 * A que familia de tramites aplica el servicio. Enum de dominio: miembros y
 * valores en espanol, alineados con `Flow` de workflow/shipment-type.
 */
export enum ServiceKind {
  /** Aereo, maritimo FCL/LCL y agenciamiento (Flow.Transporte + Flow.Agenciamiento). */
  TransporteAgenciamiento = 'transporte_agenciamiento',
  /** Paquetes comprados en USA (Flow.Paqueteria). */
  Paqueteria = 'paqueteria',
}

/** Etiqueta de presentacion del tipo de servicio. */
export const SERVICE_KIND_LABELS: Record<ServiceKind, string> = {
  [ServiceKind.TransporteAgenciamiento]: 'Transporte y agenciamiento',
  [ServiceKind.Paqueteria]: 'Paquetería',
};

/**
 * Como se determina el valor del servicio al cargarlo en un tramite.
 * Enum de comportamiento: valores en ingles, etiquetas visibles en espanol.
 */
export enum ServiceValueType {
  /** Porcentaje sobre una base (p. ej. 10%). `defaultValue` = porcentaje 0-100. */
  Percentage = 'percentage',
  /** Monto fijo sugerido. `defaultValue` = importe. */
  Fixed = 'fixed',
  /** Solo el nombre; el importe se digita al cargar los costos. `defaultValue` = null. */
  Manual = 'manual',
}

/** Etiqueta de presentacion del tipo de valor. */
export const SERVICE_VALUE_TYPE_LABELS: Record<ServiceValueType, string> = {
  [ServiceValueType.Percentage]: 'Porcentaje',
  [ServiceValueType.Fixed]: 'Monto fijo',
  [ServiceValueType.Manual]: 'Manual (se define al cargar)',
};

/**
 * DE QUIEN es el dinero de un concepto. Enum de dominio.
 *
 * Nace de una pregunta que el sistema no podia responder: `shipment_costs` se
 * llama "costos" pero sus lineas son la FACTURA DEL CLIENTE. Sumarlas para
 * obtener el costo del tramite da, exactamente, el monto de factura, y el
 * PROFIT del reporte de Agenciamiento (campo 12 menos campo 20) sale en cero en
 * todas las filas. La resta solo significa algo si se sabe que parte de lo
 * facturado es plata de terceros que HS Global unicamente traslada (impuestos,
 * almacen fiscal, naviera) y que parte son honorarios propios.
 *
 * Ademas resuelve el corte de columnas del reporte de Paqueteria, que pide
 * IMPUESTOS y OTROS / COMPRAS por separado (campos 22 y 23): la linea solo
 * guarda una etiqueta de texto libre, asi que sin esto habria que adivinar la
 * columna por el nombre.
 *
 * Lo marca el ADMINISTRADOR una vez por servicio del catalogo, y la linea lo
 * copia como snapshot igual que la etiqueta: recategorizar un servicio no debe
 * mover un reporte ya emitido.
 */
export enum CostCategory {
  /**
   * Flete de Paqueteria (peso x tarifa del casillero). Lo asigna el SISTEMA a la
   * linea de `CostLineSource.Freight`; no se elige en el catalogo.
   *
   * No es costo: es el cobro base al cliente. Lo que el flete nos CUESTA es otra
   * cifra y el reporte la calcula aparte (campo 21, TRANSPORTE INTL).
   */
  Flete = 'flete',
  /** Impuestos y liquidacion aduanal. Dinero de terceros (columna IMPUESTOS). */
  Impuestos = 'impuestos',
  /**
   * Resto de conceptos de terceros que se trasladan al cliente: permisos,
   * almacen fiscal, mensajeria, compras (columna OTROS / COMPRAS).
   */
  Otros = 'otros',
  /**
   * Honorarios de HS Global: el servicio que se vende (agencia aduanal, gestion,
   * asesoria). No es costo, es el ingreso del tramite.
   */
  Propio = 'propio',
}

export const COST_CATEGORY_LABELS: Record<CostCategory, string> = {
  [CostCategory.Flete]: 'Flete',
  [CostCategory.Impuestos]: 'Impuestos',
  [CostCategory.Otros]: 'Otros / Compras',
  [CostCategory.Propio]: 'Honorarios propios',
};

/** Ayuda de la pantalla del catalogo: por que existe cada opcion. */
export const COST_CATEGORY_DESCRIPTIONS: Record<CostCategory, string> = {
  [CostCategory.Flete]: 'Cobro base por peso. Lo calcula el sistema con la tarifa del casillero.',
  [CostCategory.Impuestos]: 'Se le paga a Hacienda. Se traslada al cliente y no deja margen.',
  [CostCategory.Otros]: 'Se le paga a un tercero (almacén, naviera, mensajería). Se traslada al cliente.',
  [CostCategory.Propio]: 'Es el servicio que vende HS Global. Es el margen del trámite.',
};

/**
 * Categorias que el administrador elige en el catalogo. `Flete` no esta: no hay
 * servicio de catalogo que sea el flete, lo genera el sistema.
 */
export const SELECTABLE_COST_CATEGORIES: readonly CostCategory[] = [
  CostCategory.Impuestos,
  CostCategory.Otros,
  CostCategory.Propio,
];

/**
 * Categoria de un servicio nuevo, y la que se le supone a los que existian antes
 * de que esta columna existiera.
 *
 * Es `Otros` —trasladado— y no `Propio` a proposito: es el supuesto
 * CONSERVADOR. Un servicio sin clasificar cuenta como costo, asi que el margen
 * sale subestimado y quien lea el reporte va a ir a marcar lo que falta. Al
 * reves, todo lo no clasificado se contaria como ingreso y el reporte mentiria
 * hacia arriba sin que nada lo delate.
 */
export const DEFAULT_COST_CATEGORY = CostCategory.Otros;

/**
 * True si la categoria es dinero de TERCEROS que solo trasladamos, es decir, lo
 * que de verdad cuesta el tramite.
 *
 * Punto unico de esa decision: la usan la columna COSTOS ASOCIADOS del reporte
 * de Agenciamiento y las columnas de costo del de Paqueteria. `Flete` y `Propio`
 * quedan fuera porque son ingreso, no costo.
 */
export function isPassThroughCost(category: CostCategory): boolean {
  return category === CostCategory.Impuestos || category === CostCategory.Otros;
}

/**
 * Tipos de valor admitidos segun el tipo de servicio.
 *
 * Los costos de Transporte y Agenciamiento se cargan al momento de recibir el
 * tramite, asi que su importe siempre se digita ahi: solo admiten Manual.
 * Paqueteria admite los tres (porcentaje, monto fijo o manual).
 */
export function allowedValueTypes(kind: ServiceKind): ServiceValueType[] {
  return kind === ServiceKind.TransporteAgenciamiento
    ? [ServiceValueType.Manual]
    : Object.values(ServiceValueType);
}

/** True si el tipo de valor es admisible para ese tipo de servicio. */
export function isValueTypeAllowed(kind: ServiceKind, valueType: ServiceValueType): boolean {
  return allowedValueTypes(kind).includes(valueType);
}

/**
 * Monedas admitidas segun el tipo de servicio (regla M6: moneda permitida por
 * campo). Los tramites de Paqueteria son compras en USA: se cotizan siempre en
 * dolares. Transporte y Agenciamiento admite ambas.
 */
export function allowedCurrencies(kind: ServiceKind): Currency[] {
  return kind === ServiceKind.Paqueteria ? [Currency.USD] : [Currency.CRC, Currency.USD];
}

/** True si la moneda es admisible para ese tipo de servicio. */
export function isCurrencyAllowed(kind: ServiceKind, currency: Currency): boolean {
  return allowedCurrencies(kind).includes(currency);
}

/** Servicio de costo (vista publica; forma equivalente a la fila de BD). */
export interface CostService {
  id: string;
  name: string;
  /** Familia de tramites a la que aplica. */
  kind: ServiceKind;
  /** De quien es el dinero del concepto (ver `CostCategory`). */
  category: CostCategory;
  /**
   * Codigo del concepto en el sistema de Factura Electronica ("COD SIS FE" de la
   * proforma: 25 para el flete aereo, 44 para impuestos, 97 para permisos).
   *
   * Es un identificador EXTERNO, no nuestro: lo emite el sistema de facturacion
   * y la proforma lo imprime al lado de cada linea. Texto y no entero porque no
   * hacemos aritmetica con el y el proveedor puede pasar a codigos con letras.
   * Null mientras no se le haya asignado uno (la proforma deja la celda vacia).
   */
  electronicInvoiceCode: string | null;
  valueType: ServiceValueType;
  /** Porcentaje (Percentage) o importe (Fixed); null cuando es Manual. */
  defaultValue: number | null;
  /**
   * Moneda del importe. Solo aplica cuando valueType = Fixed (es dinero);
   * null cuando es Percentage (es %) o Manual (se digita al cargar). Regla M2.
   */
  currency: Currency | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Valores para construir los enums de la BD (Drizzle pgEnum), sin repetirlos. */
export const SERVICE_KIND_VALUES = Object.values(ServiceKind) as [ServiceKind, ...ServiceKind[]];
export const COST_CATEGORY_VALUES = Object.values(CostCategory) as [CostCategory, ...CostCategory[]];
export const SERVICE_VALUE_TYPE_VALUES = Object.values(ServiceValueType) as [
  ServiceValueType,
  ...ServiceValueType[],
];
