/**
 * DIRECCION DEL CASILLERO DE HS GLOBAL EN MIAMI (pantalla "Configuración",
 * permiso config.manage).
 *
 * Es la direccion que el cliente copia al comprar en USA: calle, "Apto / Suite",
 * ciudad, estado, codigo postal, pais y telefono. Es la MISMA para todos los
 * clientes (lo que los distingue es la linea de Nombre), asi que es un valor
 * general del sistema y vive en `app_settings`, no por cliente.
 *
 * Mientras nadie la fije rige `MIAMI_WAREHOUSE` (la confirmada por el negocio el
 * 2026-08-08). Un error aqui manda paquetes a ninguna parte: la pantalla lo dice
 * y el cambio queda firmado (quien y cuando).
 */
import { z } from 'zod';
import type { MiamiWarehouse } from '../clients/locker';

/** Direccion vigente con su sello. */
export interface MiamiWarehouseSettingDto {
  warehouse: MiamiWarehouse;
  /** True mientras nadie la haya fijado (vale la de fabrica). */
  isDefault: boolean;
  /** UTC ISO 8601; null si rige la de fabrica. */
  updatedAt: string | null;
  updatedByName: string | null;
}

const line = (label: string, max = 120) =>
  z
    .string({ required_error: `Digita ${label}.`, invalid_type_error: `Digita ${label}.` })
    .trim()
    .min(1, `Digita ${label}.`)
    .max(max, `${label[0]!.toUpperCase()}${label.slice(1)} es demasiado largo.`);

export const setMiamiWarehouseSchema = z.object({
  addressLine1: line('la dirección'),
  addressLine2: line('el apto / suite'),
  city: line('la ciudad', 60),
  state: line('el estado', 60),
  zipCode: line('el código postal', 20),
  country: line('el país', 60),
  phone: line('el teléfono', 40),
});
export type SetMiamiWarehouseInput = z.infer<typeof setMiamiWarehouseSchema>;
