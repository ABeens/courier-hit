/**
 * Quien puede FIJAR la tasa de cambio.
 *
 * Regla del negocio: la tasa es un VALOR GENERAL del sistema (colones por 1 USD),
 * no un dato que se digite tramite por tramite. Quien carga costos la USA; solo
 * el administrador la decide. Esto no toca la regla M5: la tasa se sigue
 * guardando como snapshot en cada linea de costo, lo que cambia es quien elige
 * ese valor.
 *
 * Vive en `shared` porque la misma regla la aplican las dos capas: la web
 * bloquea el campo y la API impone la tasa vigente si el rol no puede fijarla.
 */
import { Permission, can } from '../auth/permissions';
import type { Role } from '../auth/roles';

/**
 * `true` = la tasa es global y el campo sale bloqueado en toda pantalla salvo
 * para quien tenga `Permission.ExchangeRateWrite`.
 *
 * El valor lo fija ese mismo rol en la pantalla de Configuración
 * (`/api/settings/exchange-rate`) y de ahi sale precargado en cada formulario
 * que cargue montos; quien tiene el permiso todavia puede ajustarlo sobre un
 * tramite puntual. Poniendo la bandera en `false` se vuelve al modelo viejo
 * ("cada operador digita la tasa en su tramite") sin tocar nada mas.
 */
export const EXCHANGE_RATE_IS_GLOBAL = true;

/** True si el rol puede fijar el valor de la tasa de cambio. */
export function canSetExchangeRate(role: Role): boolean {
  return !EXCHANGE_RATE_IS_GLOBAL || can(role, Permission.ExchangeRateWrite);
}
