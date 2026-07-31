/**
 * Acceso a datos de los ajustes generales.
 *
 * La lectura de la tasa vigente esta en el camino caliente (cada apertura de la
 * pantalla de costos, cada pago), asi que `currentExchangeRate` toca UNA fila por
 * clave primaria y devuelve solo el numero. La version con quien/cuando (que
 * necesita el JOIN con users) queda aparte, para la pantalla de Configuración.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { users } from '../auth/auth.schema';
import { SETTINGS_ROW_ID, appSettings, exchangeRateHistory } from './settings.schema';

export const settingsRepo = {
  /** Tasa vigente, o null si todavia nadie la fijo. */
  async currentExchangeRate(): Promise<number | null> {
    const [row] = await db
      .select({ rate: appSettings.exchangeRate })
      .from(appSettings)
      .where(eq(appSettings.id, SETTINGS_ROW_ID))
      .limit(1);
    return row?.rate ?? null;
  },

  /** Tasa vigente con su sello (quien la fijo y cuando). */
  async exchangeRateSetting() {
    const [row] = await db
      .select({
        rate: appSettings.exchangeRate,
        setAt: appSettings.exchangeRateSetAt,
        setByName: users.name,
      })
      .from(appSettings)
      .leftJoin(users, eq(users.id, appSettings.exchangeRateSetBy))
      .where(eq(appSettings.id, SETTINGS_ROW_ID))
      .limit(1);
    return row ?? { rate: null, setAt: null, setByName: null };
  },

  /**
   * Fija la tasa vigente y deja el cambio en el historial, en UNA transaccion:
   * un valor vigente sin su registro de auditoria (o al reves) es justo lo que
   * el historial existe para evitar.
   *
   * Devuelve la tasa anterior para poder reportar el cambio.
   */
  async setExchangeRate(input: {
    rate: number;
    note: string | null;
    userId: string;
  }): Promise<{ previousRate: number | null }> {
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ rate: appSettings.exchangeRate })
        .from(appSettings)
        .where(eq(appSettings.id, SETTINGS_ROW_ID))
        .limit(1);
      const previousRate = existing?.rate ?? null;
      const now = new Date();

      await tx
        .insert(appSettings)
        .values({
          id: SETTINGS_ROW_ID,
          exchangeRate: input.rate,
          exchangeRateSetBy: input.userId,
          exchangeRateSetAt: now,
          updatedAt: now,
        })
        // La fila unica puede no existir todavia (instalacion nueva): el upsert
        // cubre el primer guardado sin necesidad de sembrarla.
        .onConflictDoUpdate({
          target: appSettings.id,
          set: {
            exchangeRate: input.rate,
            exchangeRateSetBy: input.userId,
            exchangeRateSetAt: now,
            updatedAt: now,
          },
        });

      await tx.insert(exchangeRateHistory).values({
        rate: input.rate,
        previousRate,
        note: input.note,
        setBy: input.userId,
        setAt: now,
      });

      return { previousRate };
    });
  },

  /** Historial de cambios, del mas reciente al mas viejo. */
  async exchangeRateHistory(limit: number) {
    return db
      .select({
        id: exchangeRateHistory.id,
        rate: exchangeRateHistory.rate,
        previousRate: exchangeRateHistory.previousRate,
        note: exchangeRateHistory.note,
        setAt: exchangeRateHistory.setAt,
        setByName: users.name,
      })
      .from(exchangeRateHistory)
      .leftJoin(users, eq(users.id, exchangeRateHistory.setBy))
      .orderBy(desc(exchangeRateHistory.setAt))
      .limit(limit);
  },
};
