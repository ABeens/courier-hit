/**
 * Ajustes generales del sistema: la tasa de cambio y la tarifa de transporte
 * internacional. Comparten pantalla, tabla y patron (valor vigente + historial)
 * porque son la misma clase de dato: numeros que el sistema aplica IGUAL a todos
 * los tramites, no datos de uno.
 *
 * Dos valores que NO son lo mismo y por eso viajan separados hasta la pantalla:
 *   - `rate`: la tasa VIGENTE del sistema, la que se usa para convertir. La fija
 *     quien tiene `exchange_rate.write` y es lo que ve por defecto cualquier
 *     pantalla que cargue montos.
 *   - `reference`: el tipo de cambio que publica Hacienda hoy. Es informacion
 *     para decidir la anterior, nunca se guarda un monto con ella.
 *
 * Quien puede fijarla lo decide el PERMISO, no el rol: la barrera esta en las
 * rutas (`requirePermission`), asi que sumar el permiso a otro rol basta.
 */
import type {
  ExchangeRateHistoryEntryDto,
  ExchangeRateSettingDto,
  FreightRateSettingDto,
  Session,
  SetExchangeRateInput,
  SetFreightRateInput,
} from '@courier/shared';
import { exchangeRateReference } from './exchange-rate-reference';
import { settingsRepo } from './settings.repo';

/** Tope del historial que devuelve la API de una sola vez. */
const HISTORY_LIMIT = 50;

export const settingsService = {
  /** Tasa vigente + referencia del dia. */
  async exchangeRate(): Promise<ExchangeRateSettingDto> {
    // En paralelo: la referencia sale de un servicio externo y no debe sumar su
    // latencia a la lectura de la tasa vigente, que es lo unico imprescindible.
    const [setting, reference] = await Promise.all([
      settingsRepo.exchangeRateSetting(),
      exchangeRateReference.suggest(),
    ]);

    return {
      rate: setting.rate,
      updatedAt: setting.setAt?.toISOString() ?? null,
      updatedByName: setting.setByName,
      reference: { rate: reference.rate, day: reference.day },
    };
  },

  /**
   * Fija la tasa vigente. El valor ya viene validado por el esquema de la ruta
   * (`setExchangeRateSchema`), que es el mismo techo que exigen los bordes que
   * la consumen: una tasa que quede vigente pero no sirva para cobrar seria peor
   * que no tener ninguna.
   */
  async setExchangeRate(
    session: Session,
    input: SetExchangeRateInput,
  ): Promise<ExchangeRateSettingDto> {
    await settingsRepo.setExchangeRate({
      rate: input.rate,
      note: input.note?.trim() || null,
      userId: session.userId,
    });
    return settingsService.exchangeRate();
  },

  /** Historial de cambios (auditoria), del mas reciente al mas viejo. */
  async exchangeRateHistory(): Promise<ExchangeRateHistoryEntryDto[]> {
    const rows = await settingsRepo.exchangeRateHistory(HISTORY_LIMIT);
    return rows.map((row) => ({
      id: row.id,
      rate: row.rate,
      previousRate: row.previousRate,
      note: row.note,
      setAt: row.setAt.toISOString(),
      setByName: row.setByName,
    }));
  },

  /**
   * Tarifa de transporte internacional vigente (USD por libra).
   *
   * A diferencia de la tasa de cambio no lleva referencia externa: nadie publica
   * un indicador del flete. El valor sale de lo que la naviera le cobre a HS
   * Global, asi que la unica fuente posible es lo que el administrador digite.
   */
  async freightRate(): Promise<FreightRateSettingDto> {
    const setting = await settingsRepo.freightRateSetting();
    return {
      usdPerLb: setting.usdPerLb,
      updatedAt: setting.setAt?.toISOString() ?? null,
      updatedByName: setting.setByName,
    };
  },

  /**
   * Fija la tarifa vigente. Solo afecta a los tramites que se FACTUREN a partir
   * de ahora: los ya aprobados llevan su tarifa congelada en la fila
   * (`shipments.freight_rate_usd_per_lb`), justamente para que este cambio no
   * reescriba el margen de meses cerrados.
   */
  async setFreightRate(
    session: Session,
    input: SetFreightRateInput,
  ): Promise<FreightRateSettingDto> {
    await settingsRepo.setFreightRate({
      usdPerLb: input.usdPerLb,
      note: input.note?.trim() || null,
      userId: session.userId,
    });
    return settingsService.freightRate();
  },
};
