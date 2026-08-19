/**
 * Tasa de cambio GLOBAL del sistema (pantalla "Configuración", permiso
 * exchange_rate.write).
 *
 * Es el valor que el sistema usa para convertir: la fija quien tiene el permiso
 * y de ahi sale la tasa por defecto de toda pantalla que cargue montos. El tipo
 * de cambio publicado del dia viaja al lado, como REFERENCIA para decidirla;
 * nunca se usa solo para guardar un monto.
 *
 * Convencion unica del sistema: colones por 1 USD.
 */
import { z } from 'zod';

/**
 * Valor admisible de la tasa global.
 *
 * El techo es el MAS ESTRECHO de los que ya exigen los bordes que la consumen
 * (`exchangeRateSchema` de pagos, 10.000): una tasa que aqui pasara y alla no
 * dejaria el sistema con una tasa vigente imposible de usar para cobrar.
 */
export const globalExchangeRateSchema = z
  .number({ invalid_type_error: 'La tasa de cambio debe ser un número.' })
  .positive('La tasa de cambio debe ser mayor que cero.')
  .max(10_000, 'Esa tasa de cambio no parece válida.');

/** Cuerpo de `PUT /api/settings/exchange-rate`. */
export const setExchangeRateSchema = z.object({
  rate: globalExchangeRateSchema,
  /** Por que se cambio (queda en el historial). Opcional. */
  note: z.string().trim().max(200, 'La nota es demasiado larga.').optional(),
});
export type SetExchangeRateInput = z.infer<typeof setExchangeRateSchema>;

/** El tipo de cambio publicado hoy. Solo referencia: no se guarda ningun monto con esto. */
export interface ExchangeRateReferenceDto {
  /** Colones por 1 USD, o null si la integracion esta apagada o falló. */
  rate: number | null;
  /**
   * DIA del indicador (AAAA-MM-DD), no un instante: la fuente publica un valor
   * por dia calendario de Costa Rica, sin hora. Por eso NO pasa por la
   * conversion a hora local (`formatDayInput`, no `formatDate`): leerlo como
   * instante lo correria un dia hacia atras. Null si no hubo dato.
   */
  day: string | null;
}

/** Respuesta de `GET /api/settings/exchange-rate`. */
export interface ExchangeRateSettingDto {
  /** Tasa vigente del sistema; null si todavia nadie la fijo. */
  rate: number | null;
  /** Cuando se fijo (ISO, UTC); null si no hay tasa. */
  updatedAt: string | null;
  /** Quien la fijo; null si no hay tasa o el usuario ya no existe. */
  updatedByName: string | null;
  /** Tipo de cambio de referencia del dia. */
  reference: ExchangeRateReferenceDto;
}

/** Una entrada del historial de cambios de la tasa. */
export interface ExchangeRateHistoryEntryDto {
  id: string;
  rate: number;
  /** Tasa que estaba vigente antes; null en el primer registro. */
  previousRate: number | null;
  note: string | null;
  /** Cuando se aplico el cambio (ISO, UTC). */
  setAt: string;
  setByName: string | null;
}
