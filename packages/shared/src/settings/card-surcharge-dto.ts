/**
 * RECARGO POR PAGO CON TARJETA como ajuste general del sistema (pantalla
 * "Configuración", permiso `card_surcharge.write`).
 *
 * Es lo que cobra la pasarela por cada cobro con tarjeta y que se le traslada al
 * cliente: un porcentaje del total mas un fijo por transaccion. Vive donde ya
 * viven la tasa de cambio y la tarifa de flete, y por el mismo motivo: son
 * numeros que el sistema aplica IGUAL a todos los tramites y que cambian cuando
 * la contraparte los renegocia, no cuando hay un despliegue.
 *
 * NO es un monto transaccional: son las CONDICIONES con las que despues se
 * calcula uno (`cardChargeFor`). Por eso no lleva tasa de cambio (regla M5 no
 * aplica, igual que la tarifa de flete): el fijo esta en dolares por definicion,
 * y la conversion a colones la hace cada cobro con SU tasa congelada.
 *
 * El recargo que ya se le cobro a un cliente NO se mueve al cambiar esto: quedo
 * congelado en su abono (`payments.surcharge_amount`) y en la linea de costo que
 * se asento en su factura.
 */
import { z } from 'zod';
import { Permission, can } from '../auth/permissions';
import type { Role } from '../auth/roles';

/**
 * Porcentaje de la comision, de 0 a 100 (regla M3). El techo real es mas bajo
 * que 100 y no es un capricho: con el 100 % el despeje del total no existe (ver
 * `cardChargeFor`), y una pasarela que se quede la mitad del cobro no es una
 * pasarela, es un dedazo.
 */
export const cardSurchargePercentSchema = z
  .number({ invalid_type_error: 'El porcentaje debe ser un número.' })
  .min(0, 'El porcentaje no puede ser negativo.')
  .max(50, 'Ese porcentaje no parece válido.');

/** Cargo fijo por transaccion, en DOLARES. Cero es valido: hay tarifas sin fijo. */
export const cardSurchargeFixedSchema = z
  .number({ invalid_type_error: 'El cargo fijo debe ser un número.' })
  .nonnegative('El cargo fijo no puede ser negativo.')
  .max(100, 'Ese cargo fijo no parece válido.');

/** Cuerpo de `PUT /api/settings/card-surcharge`. Las dos cifras viajan juntas. */
export const setCardSurchargeSchema = z.object({
  /**
   * Las DOS van siempre, aunque solo cambie una. La comision es una sola condicion
   * con dos partes: guardar el porcentaje sin el fijo dejaria vigente una mezcla
   * de la tarifa nueva y la vieja que no es la de ningun contrato.
   */
  percent: cardSurchargePercentSchema,
  fixedUsd: cardSurchargeFixedSchema,
  /** Por que se cambio (queda en el historial). Opcional. */
  note: z.string().trim().max(200, 'La nota es demasiado larga.').optional(),
});
export type SetCardSurchargeInput = z.infer<typeof setCardSurchargeSchema>;

/** Respuesta de `GET /api/settings/card-surcharge`. */
export interface CardSurchargeSettingDto {
  /** Porcentaje vigente, de 0 a 100. */
  percent: number;
  /** Cargo fijo vigente, en dolares. */
  fixedUsd: number;
  /**
   * True si lo vigente es el DEFECTO del sistema y no algo que alguien fijo. La
   * pantalla lo dice en vez de presentar el valor de fabrica como una decision
   * del negocio.
   */
  isDefault: boolean;
  /** Cuando se fijo (ISO, UTC); null si nadie lo ha fijado. */
  updatedAt: string | null;
  /** Quien lo fijo; null si nadie lo ha fijado o el usuario ya no existe. */
  updatedByName: string | null;
}

/** Una entrada del historial de cambios del recargo. */
export interface CardSurchargeHistoryEntryDto {
  id: string;
  percent: number;
  fixedUsd: number;
  /** Los que estaban antes; null en el primer registro (regian los de fabrica). */
  previousPercent: number | null;
  previousFixedUsd: number | null;
  note: string | null;
  setAt: string;
  setByName: string | null;
}

/** True si el rol puede fijar el recargo por pago con tarjeta. */
export function canSetCardSurcharge(role: Role): boolean {
  return can(role, Permission.CardSurchargeWrite);
}
