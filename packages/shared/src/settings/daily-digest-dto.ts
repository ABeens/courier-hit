/**
 * CORREO DIARIO al cliente (decision P16 del SOW de proformas).
 *
 * Se eliminaron los avisos inmediatos por cambio de estado: todos los cambios de
 * los paquetes y tramites de un cliente se le avisan en UN correo diario, a una
 * hora configurable (6:00 a. m. por defecto). Los correos de cuenta (invitacion,
 * recuperar contraseña) y el comprobante de un pago siguen siendo inmediatos.
 *
 * La hora se configura en la HORA DEL NEGOCIO (Costa Rica), que es como la piensa
 * quien la fija. El registro de cuando salio el ultimo correo se guarda en UTC,
 * como toda fecha del sistema (CLAUDE.md).
 */
import { z } from 'zod';

/** Zona horaria del negocio: todos los clientes son de Costa Rica. */
export const BUSINESS_TIME_ZONE = 'America/Costa_Rica';

/** Hora por defecto del correo diario, en la zona del negocio. */
export const DEFAULT_DAILY_DIGEST_HOUR = 6;

/** Configuracion vigente del correo diario. */
export interface DailyDigestSettingDto {
  /** Hora de envio (0 a 23) en `timeZone`. */
  hour: number;
  timeZone: string;
  /** True mientras nadie la haya fijado (vale el defecto). */
  isDefault: boolean;
  /** Cuando salio el ultimo correo diario, UTC ISO 8601; null si nunca. */
  lastRunAt: string | null;
}

export const setDailyDigestSchema = z.object({
  hour: z
    .number({ invalid_type_error: 'Elige una hora.' })
    .int('La hora debe ser entera.')
    .min(0, 'La hora va de 0 a 23.')
    .max(23, 'La hora va de 0 a 23.'),
});
export type SetDailyDigestInput = z.infer<typeof setDailyDigestSchema>;

/** Fecha (AAAA-MM-DD) y hora (0-23) de un instante en una zona horaria. */
export function localDayAndHour(instant: Date, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/**
 * ¿Toca enviar el correo diario AHORA?
 *
 * Toca cuando en la zona del negocio ya es la hora configurada (o mas tarde) y el
 * ultimo envio no fue HOY en esa misma zona. El "o mas tarde" es lo que hace que
 * un robot que estuvo caido a las 6:00 lo mande en cuanto vuelve, y el "no fue
 * hoy" es lo que impide mandarlo dos veces el mismo dia.
 */
export function isDailyDigestDue(
  now: Date,
  hour: number,
  lastRunAt: Date | null,
  timeZone: string = BUSINESS_TIME_ZONE,
): boolean {
  const current = localDayAndHour(now, timeZone);
  if (current.hour < hour) return false;
  if (!lastRunAt) return true;
  return localDayAndHour(lastRunAt, timeZone).day !== current.day;
}
