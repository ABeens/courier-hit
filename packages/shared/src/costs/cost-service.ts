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
export const SERVICE_VALUE_TYPE_VALUES = Object.values(ServiceValueType) as [
  ServiceValueType,
  ...ServiceValueType[],
];
