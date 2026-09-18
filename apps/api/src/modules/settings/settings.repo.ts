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
import {
  SETTINGS_ROW_ID,
  appSettings,
  cardSurchargeHistory,
  exchangeRateHistory,
  freightRateHistory,
} from './settings.schema';

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

  /**
   * Tarifa de transporte internacional vigente (USD por libra), o null si nadie
   * la fijo. Camino caliente igual que la tasa: la consulta cada aprobacion de
   * costos de Paqueteria, asi que toca una fila por clave primaria.
   */
  async currentFreightRate(): Promise<number | null> {
    const [row] = await db
      .select({ rate: appSettings.freightRateUsdPerLb })
      .from(appSettings)
      .where(eq(appSettings.id, SETTINGS_ROW_ID))
      .limit(1);
    return row?.rate ?? null;
  },

  /** Tarifa vigente con su sello (quien la fijo y cuando). */
  async freightRateSetting() {
    const [row] = await db
      .select({
        usdPerLb: appSettings.freightRateUsdPerLb,
        setAt: appSettings.freightRateSetAt,
        setByName: users.name,
      })
      .from(appSettings)
      .leftJoin(users, eq(users.id, appSettings.freightRateSetBy))
      .where(eq(appSettings.id, SETTINGS_ROW_ID))
      .limit(1);
    return row ?? { usdPerLb: null, setAt: null, setByName: null };
  },

  /**
   * Fija la tarifa vigente y deja el cambio en el historial, en UNA transaccion.
   * Mismo patron que `setExchangeRate` y por el mismo motivo: un valor vigente sin
   * su registro de auditoria es justo lo que el historial existe para evitar.
   */
  async setFreightRate(input: {
    usdPerLb: number;
    note: string | null;
    userId: string;
  }): Promise<{ previousUsdPerLb: number | null }> {
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ rate: appSettings.freightRateUsdPerLb })
        .from(appSettings)
        .where(eq(appSettings.id, SETTINGS_ROW_ID))
        .limit(1);
      const previousUsdPerLb = existing?.rate ?? null;
      const now = new Date();

      await tx
        .insert(appSettings)
        .values({
          id: SETTINGS_ROW_ID,
          freightRateUsdPerLb: input.usdPerLb,
          freightRateSetBy: input.userId,
          freightRateSetAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: appSettings.id,
          set: {
            freightRateUsdPerLb: input.usdPerLb,
            freightRateSetBy: input.userId,
            freightRateSetAt: now,
            updatedAt: now,
          },
        });

      await tx.insert(freightRateHistory).values({
        usdPerLb: input.usdPerLb,
        previousUsdPerLb,
        note: input.note,
        setBy: input.userId,
        setAt: now,
      });

      return { previousUsdPerLb };
    });
  },

  /**
   * Recargo por pago con tarjeta VIGENTE, o null en cada cifra si nadie lo ha
   * fijado. Camino caliente igual que la tasa: lo consulta cada cotizacion y cada
   * cobro con tarjeta, asi que toca una fila por clave primaria.
   *
   * Devuelve las dos cifras crudas y no una tarifa ya armada: quien decide que
   * hacer con el "nadie lo ha fijado" es el servicio, que es el que conoce el
   * defecto.
   */
  async currentCardSurcharge(): Promise<{ percent: number | null; fixedUsd: number | null }> {
    const [row] = await db
      .select({
        percent: appSettings.cardSurchargePercent,
        fixedUsd: appSettings.cardSurchargeFixedUsd,
      })
      .from(appSettings)
      .where(eq(appSettings.id, SETTINGS_ROW_ID))
      .limit(1);
    return { percent: row?.percent ?? null, fixedUsd: row?.fixedUsd ?? null };
  },

  /** El mismo recargo con su sello (quien lo fijo y cuando), para Configuración. */
  async cardSurchargeSetting() {
    const [row] = await db
      .select({
        percent: appSettings.cardSurchargePercent,
        fixedUsd: appSettings.cardSurchargeFixedUsd,
        setAt: appSettings.cardSurchargeSetAt,
        setByName: users.name,
      })
      .from(appSettings)
      .leftJoin(users, eq(users.id, appSettings.cardSurchargeSetBy))
      .where(eq(appSettings.id, SETTINGS_ROW_ID))
      .limit(1);
    return row ?? { percent: null, fixedUsd: null, setAt: null, setByName: null };
  },

  /**
   * Fija el recargo vigente y deja el cambio en el historial, en UNA transaccion,
   * por lo mismo que la tasa: un valor vigente sin su registro de auditoria (o al
   * reves) es justo lo que el historial existe para evitar.
   *
   * Las dos cifras se escriben SIEMPRE juntas: son una sola condicion comercial.
   */
  async setCardSurcharge(input: {
    percent: number;
    fixedUsd: number;
    note: string | null;
    userId: string;
  }): Promise<{ previousPercent: number | null; previousFixedUsd: number | null }> {
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          percent: appSettings.cardSurchargePercent,
          fixedUsd: appSettings.cardSurchargeFixedUsd,
        })
        .from(appSettings)
        .where(eq(appSettings.id, SETTINGS_ROW_ID))
        .limit(1);
      const previousPercent = existing?.percent ?? null;
      const previousFixedUsd = existing?.fixedUsd ?? null;
      const now = new Date();

      await tx
        .insert(appSettings)
        .values({
          id: SETTINGS_ROW_ID,
          cardSurchargePercent: input.percent,
          cardSurchargeFixedUsd: input.fixedUsd,
          cardSurchargeSetBy: input.userId,
          cardSurchargeSetAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: appSettings.id,
          set: {
            cardSurchargePercent: input.percent,
            cardSurchargeFixedUsd: input.fixedUsd,
            cardSurchargeSetBy: input.userId,
            cardSurchargeSetAt: now,
            updatedAt: now,
          },
        });

      await tx.insert(cardSurchargeHistory).values({
        percent: input.percent,
        fixedUsd: input.fixedUsd,
        previousPercent,
        previousFixedUsd,
        note: input.note,
        setBy: input.userId,
        setAt: now,
      });

      return { previousPercent, previousFixedUsd };
    });
  },

  /** Historial del recargo, del mas reciente al mas viejo. */
  async cardSurchargeHistory(limit: number) {
    return db
      .select({
        id: cardSurchargeHistory.id,
        percent: cardSurchargeHistory.percent,
        fixedUsd: cardSurchargeHistory.fixedUsd,
        previousPercent: cardSurchargeHistory.previousPercent,
        previousFixedUsd: cardSurchargeHistory.previousFixedUsd,
        note: cardSurchargeHistory.note,
        setAt: cardSurchargeHistory.setAt,
        setByName: users.name,
      })
      .from(cardSurchargeHistory)
      .leftJoin(users, eq(users.id, cardSurchargeHistory.setBy))
      .orderBy(desc(cardSurchargeHistory.setAt))
      .limit(limit);
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
