/**
 * Servicio de costo: entrada del catalogo de conceptos que el administrador puede
 * cargar manualmente sobre los tramites de Transporte y Agenciamiento.
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

/** Servicio de costo (vista publica; forma equivalente a la fila de BD). */
export interface CostService {
  id: string;
  name: string;
  valueType: ServiceValueType;
  /** Porcentaje (Percentage) o importe (Fixed); null cuando es Manual. */
  defaultValue: number | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Valores para construir el enum de la BD (Drizzle pgEnum), sin repetirlos. */
export const SERVICE_VALUE_TYPE_VALUES = Object.values(ServiceValueType) as [
  ServiceValueType,
  ...ServiceValueType[],
];
