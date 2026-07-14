/**
 * Tipos de tramite y a que maquina de estados (Flow) pertenece cada uno.
 * Fuente autoritativa: docs/flujo.md (seccion "Tramites", lineas 30-71).
 *
 * Hay 5 TIPOS de tramite pero solo 3 FLOWS (maquinas de estado): los tres tipos
 * de transporte (aereo, maritimo FCL, maritimo LCL) comparten estados, mientras
 * que Paqueteria y Agenciamiento tienen los suyos propios.
 *
 * Las claves (valor del enum) son estables: alimentan enums de Postgres.
 */

/** Tipo de tramite que selecciona el administrador (docs/flujo.md L31-36). */
export enum ShipmentType {
  Paqueteria = 'paqueteria',
  Aereo = 'aereo',
  MaritimoFCL = 'maritimo_fcl',
  MaritimoLCL = 'maritimo_lcl',
  Agenciamiento = 'agenciamiento',
}

/** Maquina de estados que gobierna un tramite. Un flow agrupa >= 1 tipo. */
export enum Flow {
  Paqueteria = 'paqueteria',
  Transporte = 'transporte',
  Agenciamiento = 'agenciamiento',
}

/** Etiqueta de presentacion del tipo de tramite. */
export const SHIPMENT_TYPE_LABELS: Record<ShipmentType, string> = {
  [ShipmentType.Paqueteria]: 'Paquetería',
  [ShipmentType.Aereo]: 'Aéreo',
  [ShipmentType.MaritimoFCL]: 'Marítimo FCL',
  [ShipmentType.MaritimoLCL]: 'Marítimo LCL',
  [ShipmentType.Agenciamiento]: 'Agenciamiento',
};

/** Etiqueta de presentacion del flow. */
export const FLOW_LABELS: Record<Flow, string> = {
  [Flow.Paqueteria]: 'Paquetería',
  [Flow.Transporte]: 'Transporte (aéreo y marítimo)',
  [Flow.Agenciamiento]: 'Agenciamiento',
};

/** Relacion ShipmentType -> Flow (docs/flujo.md L37-71). */
export const FLOW_BY_TYPE: Record<ShipmentType, Flow> = {
  [ShipmentType.Paqueteria]: Flow.Paqueteria,
  [ShipmentType.Aereo]: Flow.Transporte,
  [ShipmentType.MaritimoFCL]: Flow.Transporte,
  [ShipmentType.MaritimoLCL]: Flow.Transporte,
  [ShipmentType.Agenciamiento]: Flow.Agenciamiento,
};

/** El flow (maquina de estados) que aplica a un tipo de tramite. */
export function flowForType(type: ShipmentType): Flow {
  return FLOW_BY_TYPE[type];
}

/** Valores para construir los enums de la BD (Drizzle pgEnum), sin repetirlos. */
export const SHIPMENT_TYPE_VALUES = Object.values(ShipmentType) as [ShipmentType, ...ShipmentType[]];
export const FLOW_VALUES = Object.values(Flow) as [Flow, ...Flow[]];
