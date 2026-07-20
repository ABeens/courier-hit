/**
 * Catalogos de apoyo del alta de tramites de Paqueteria: la tienda donde se
 * compro y el transportista que mueve el paquete en USA.
 *
 * Fuente literal: source_docs/Material/Tiendas.txt y Carriers.txt (referenciados
 * por docs/manuales/flujo.md L111-112). Ambos cierran con 'OTRO', asi que la
 * lista es CERRADA: no hace falta texto libre y el desplegable siempre tiene una
 * opcion valida.
 *
 * Viven en codigo (no en BD) porque cambian con un despliegue, no a diario, y
 * ambos lados (API y web) necesitan exactamente la misma lista.
 */

/** Tienda donde el cliente compro el paquete (Paqueteria). */
export const STORES = [
  'AMAZON',
  'EBAY',
  'OLD NAVY',
  'SHEIN',
  'TEMU',
  'WALMART',
  'HOME DEPOT',
  'PANDORA',
  'VICTORIA SECRET',
  'SARAH',
  'H&M',
  'OTRO',
] as const;

export type Store = (typeof STORES)[number];

/** Transportista que mueve el paquete hasta la bodega de Miami (Paqueteria). */
export const CARRIERS = [
  'AMAZON LOGISTICS',
  'USPS',
  'FEDEX',
  'UPS',
  'DHL',
  'YUN EXPRESS',
  'GOFO',
  'EMS',
  'OTRO',
] as const;

export type Carrier = (typeof CARRIERS)[number];

export function isStore(value: string): value is Store {
  return (STORES as readonly string[]).includes(value);
}

export function isCarrier(value: string): value is Carrier {
  return (CARRIERS as readonly string[]).includes(value);
}
