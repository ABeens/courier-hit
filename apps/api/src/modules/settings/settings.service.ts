/**
 * Ajustes generales del sistema. Hoy uno solo: la tasa de cambio.
 *
 * Dos valores que NO son lo mismo y por eso viajan separados hasta la pantalla:
 *   - `rate`: la tasa VIGENTE del sistema, la que se usa para convertir. La fija
 *     quien tiene `exchange_rate.write` y es lo que ve por defecto cualquier
 *     pantalla que cargue montos.
 *   - `reference`: lo que publica el BCCR hoy. Es informacion para decidir la
 *     anterior, nunca se guarda un monto con ella.
 *
 * Quien puede fijarla lo decide el PERMISO, no el rol: la barrera esta en las
 * rutas (`requirePermission`), asi que sumar el permiso a otro rol basta.
 */
import type {
  ExchangeRateHistoryEntryDto,
  ExchangeRateSettingDto,
  Session,
  SetExchangeRateInput,
} from '@courier/shared';
import { exchangeRateReference } from './bccr-reference';
import { settingsRepo } from './settings.repo';

/** Tope del historial que devuelve la API de una sola vez. */
const HISTORY_LIMIT = 50;

export const settingsService = {
  /** Tasa vigente + referencia del BCCR. */
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
      reference: { rate: reference.rate, date: reference.date },
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
};
