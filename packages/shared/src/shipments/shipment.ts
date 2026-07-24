/**
 * Entidad Tramite (Shipment): la unidad central de la operacion. Un tramite es
 * un paquete de Paqueteria comprado en USA, un transporte aereo/maritimo o un
 * agenciamiento aduanal. Fuente: docs/manuales/flujo.md L30-145.
 *
 * El TIPO (`ShipmentType`) lo elige quien lo crea; el FLOW (maquina de estados)
 * se deriva de el con `flowForType` y NO se persiste: derivarlo evita que tipo y
 * flow se desincronicen. Los estados y sus transiciones viven en `workflow/`.
 *
 * Convencion del repo: nombres de codigo en ingles; etiquetas y valores de enum
 * de dominio en espanol. Ver CLAUDE.md.
 */
import type { State } from '../workflow/states';
import { Flow, ShipmentType, flowForType } from '../workflow/shipment-type';

/**
 * Cliente al que pertenece el tramite, en la forma reducida que necesitan los
 * dashboards (no se expone el perfil completo del casillero).
 */
export interface ShipmentClientRef {
  id: string;
  /** Codigo de casillero, `HS-1042`. */
  code: string;
  name: string;
}

/** Tramite tal como lo devuelve la API. */
export interface ShipmentDto {
  id: string;
  /** Consecutivo de negocio `HS000001000` (docs/manuales/flujo.md L92). */
  code: string;
  shipmentType: ShipmentType;
  /** Derivado de `shipmentType`; viaja en la respuesta para no recalcularlo en la UI. */
  flow: Flow;
  state: State;
  client: ShipmentClientRef;
  /** Guia: tracking en Paqueteria, AWB/BL en Transporte y Agenciamiento. */
  tracking: string;
  /** Descripcion / REF. */
  description: string;

  // --- Solo Paqueteria ---
  store: string | null;
  carrier: string | null;
  /** HAWB / HBL, solo digitos. */
  hawb: string | null;
  /** Peso en kilos, entero (siempre redondeado hacia arriba al guardar). */
  weightKg: number | null;

  // --- Solo Transporte y Agenciamiento ---
  warehouse: string | null;
  /** DUA con formato ###-####-######. */
  dua: string | null;
  billingNotes: string | null;

  /**
   * Ruta operativa del distrito de entrega del cliente. Se resuelve al leer
   * (join con las rutas por distrito) en vez de copiarse al tramite: si el
   * administrador reasigna la ruta de un distrito, los tramites en curso la
   * reflejan sin migrar datos.
   */
  routeNumber: number | null;

  /**
   * Monto de factura, congelado al APROBAR los costos. Va en las DOS monedas
   * (regla M2: ninguna cifra sin moneda) porque asi lo pide el dashboard
   * ("Monto de Factura ($ y ₡)", docs/manuales/flujo.md L104). Null mientras los
   * costos no se hayan aprobado.
   */
  invoiceTotalUsd: number | null;
  invoiceTotalCrc: number | null;

  /** Instantes en UTC, ISO 8601. La hora local se arma en la presentacion. */
  createdAt: string;
  updatedAt: string;
}

/** True si el tipo usa los campos propios de Paqueteria (tienda, transportista, HAWB, peso). */
export function usesPackageFields(type: ShipmentType): boolean {
  return flowForType(type) === Flow.Paqueteria;
}

/**
 * Campos de datos editables de un tramite. Nombres de codigo en ingles (no son
 * dominio): coinciden 1:1 con las claves de `UpdateShipmentInput` y con las
 * columnas de la tabla. La maquina de estados declara, POR estado, cuales admiten
 * edicion (`Step.editable`); este enum es el vocabulario de esa regla, para que
 * API y web la consuman de un solo lugar en vez de duplicar la lista de campos.
 */
export enum ShipmentField {
  Tracking = 'tracking',
  Description = 'description',
  // Solo Paqueteria
  Store = 'store',
  Carrier = 'carrier',
  Hawb = 'hawb',
  WeightKg = 'weightKg',
  // Solo Transporte y Agenciamiento
  Warehouse = 'warehouse',
  Dua = 'dua',
  BillingNotes = 'billingNotes',
}

/** Tipos de tramite que el administrador captura y mueve a mano (todo menos Paqueteria). */
export const MANUAL_SHIPMENT_TYPES: readonly ShipmentType[] = [
  ShipmentType.Aereo,
  ShipmentType.MaritimoFCL,
  ShipmentType.MaritimoLCL,
  ShipmentType.Agenciamiento,
];

/**
 * Peso facturable en kilos. El manual es explicito: "a la hora de salvar siempre
 * redondea hacia arriba. Ej: 1.1 => 2" (docs/manuales/flujo.md L115). Punto UNICO
 * de redondeo del peso: nadie mas debe llamar a Math.ceil sobre un peso.
 */
export function roundWeightKg(weight: number): number {
  return Math.ceil(weight);
}

/**
 * Formato del consecutivo de negocio: `HS` + 9 digitos (docs/manuales/flujo.md
 * L92, ejemplo HS000001000). El numero sale de una secuencia de Postgres; aqui
 * vive el formato para que API y web lo interpreten igual.
 */
export function formatShipmentCode(sequence: number | string): string {
  return `HS${String(sequence).padStart(9, '0')}`;
}
