/**
 * Tarifa de TRANSPORTE INTERNACIONAL: lo que a HS Global le cuesta mover una
 * libra desde Miami, en dolares (pantalla "Configuración", permiso
 * freight_rate.write).
 *
 * Es la unica pieza del mapeo de campos que el sistema no tenia de ninguna forma.
 * `shipment_costs` guarda lo que se le COBRA al cliente; esto es lo que nos
 * CUESTA, y sin ese numero el campo 21 del reporte de Paqueteria —y con el el
 * GROSS PROFIT y el margen— no se puede calcular. El mapeo la describe como
 * constante ("(WEIGHT KG × 2.204) × 3.66"), pero un precio de flete cambia con el
 * mercado y quemarlo en el codigo significaria un despliegue cada vez: vive donde
 * ya vive la tasa de cambio, que es el otro valor general del sistema.
 *
 * NO es un monto transaccional: es un PRECIO UNITARIO de referencia (USD por
 * libra), no una cifra aplicada a un tramite. Por eso no lleva tasa de cambio
 * (regla M5 no aplica, igual que el limite de credito o el valor declarado): la
 * conversion a colones, si hace falta, la hace quien la use con SU tasa.
 */
import { z } from 'zod';
import { Permission, can } from '../auth/permissions';
import type { Role } from '../auth/roles';

/**
 * Factor de conversion de kilos a libras del mapeo de campos ("WEIGHT KG ×
 * 2.204"). Esto SI es constante: es una equivalencia fisica, no un precio.
 *
 * Se usa el 2.204 del documento y no el valor exacto (2.20462...) a proposito: el
 * reporte tiene que dar el mismo numero que la hoja de calculo con la que la
 * operacion lo va a cuadrar. Una diferencia en el cuarto decimal es invisible en
 * un paquete y visible en el total del mes.
 */
export const KG_TO_LB = 2.204;

/**
 * Valor admisible de la tarifa, en USD por libra. El tope no es una regla del
 * negocio sino un atajo de dedazos: una tarifa de tres digitos por libra no es
 * una tarifa, es un cero de mas.
 */
export const freightRateSchema = z
  .number({ invalid_type_error: 'La tarifa debe ser un número.' })
  .positive('La tarifa debe ser mayor que cero.')
  .max(999, 'Esa tarifa no parece válida.');

/** Cuerpo de `PUT /api/settings/freight-rate`. */
export const setFreightRateSchema = z.object({
  /** USD por libra. Moneda explicita en la unidad, no hay otra opcion (regla M2). */
  usdPerLb: freightRateSchema,
  /** Por que se cambio (queda en el historial). Opcional. */
  note: z.string().trim().max(200, 'La nota es demasiado larga.').optional(),
});
export type SetFreightRateInput = z.infer<typeof setFreightRateSchema>;

/** Respuesta de `GET /api/settings/freight-rate`. */
export interface FreightRateSettingDto {
  /** USD por libra vigente; null si todavia nadie la fijo. */
  usdPerLb: number | null;
  /** Cuando se fijo (ISO, UTC); null si no hay tarifa. */
  updatedAt: string | null;
  /** Quien la fijo; null si no hay tarifa o el usuario ya no existe. */
  updatedByName: string | null;
}

/** True si el rol puede fijar la tarifa de transporte internacional. */
export function canSetFreightRate(role: Role): boolean {
  return can(role, Permission.FreightRateWrite);
}
