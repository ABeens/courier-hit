/**
 * Acceso a datos de las llaves de API. Sin reglas: el servicio decide, esto
 * lee y escribe.
 */
import { and, count, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { ApiKeyRevokeReason } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { apiKeys, type NewApiKeyRow } from './api-keys.schema';

/**
 * Lo que hace falta para autenticar una peticion de la API publica: la llave y,
 * en el mismo viaje, el estado de la cuenta que hay detras. Van juntos porque
 * cada peticion necesita las dos cosas y separarlas serian dos consultas por
 * peticion para responder una sola pregunta ("¿puede pasar?").
 */
export interface ApiKeyAuthRow {
  id: string;
  clientId: string;
  clientCode: string;
  environment: string;
  tokenHash: string;
  revokedAt: Date | null;
  revokedReason: ApiKeyRevokeReason | null;
  lastUsedAt: Date | null;
  userId: string;
  userStatus: string;
}

export const apiKeysRepo = {
  /** Las llaves de un casillero, de la mas nueva a la mas vieja (revocadas incluidas). */
  async listByClient(clientId: string) {
    return db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.clientId, clientId))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  },

  /** Cuantas llaves vivas tiene el casillero. Es lo que compara el tope. */
  async countActive(clientId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.clientId, clientId), isNull(apiKeys.revokedAt)));
    return row?.n ?? 0;
  },

  async findById(id: string) {
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    return row ?? null;
  },

  /**
   * La llave con ese identificador publico, con el estado de su cuenta.
   *
   * Devuelve TAMBIEN las revocadas a proposito: quien llama necesita poder
   * distinguir "esta llave no existe" de "esta llave la revocaste tu", que son
   * dos mensajes distintos para el integrador.
   */
  async findForAuth(tokenId: string): Promise<ApiKeyAuthRow | null> {
    const [row] = await db
      .select({
        id: apiKeys.id,
        clientId: apiKeys.clientId,
        clientCode: clients.code,
        environment: apiKeys.environment,
        tokenHash: apiKeys.tokenHash,
        revokedAt: apiKeys.revokedAt,
        revokedReason: apiKeys.revokedReason,
        lastUsedAt: apiKeys.lastUsedAt,
        userId: users.id,
        userStatus: users.status,
      })
      .from(apiKeys)
      .innerJoin(clients, eq(apiKeys.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(eq(apiKeys.tokenId, tokenId))
      .limit(1);
    return (row as ApiKeyAuthRow | undefined) ?? null;
  },

  async insert(row: NewApiKeyRow) {
    const [created] = await db.insert(apiKeys).values(row).returning();
    return created!;
  },

  /**
   * Marca la llave como revocada, pero SOLO si sigue viva. La condicion va en el
   * WHERE y no en un `if` del servicio para que dos revocaciones simultaneas no
   * puedan pisar la fecha ni el motivo de la primera.
   */
  async revoke(id: string, reason: ApiKeyRevokeReason) {
    const [row] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning();
    return row ?? null;
  },

  /**
   * Anota el uso de la llave. Condicional: solo escribe si el ultimo uso
   * registrado es anterior al corte, para que un cliente que consulta cada
   * segundo no convierta cada lectura en un UPDATE (y en una fila muerta mas
   * para el autovacuum). El dato que interesa es "esta llave se usa", con la
   * resolucion de minutos que da `TOUCH_INTERVAL_MS`, no el instante exacto.
   */
  async touch(id: string, before: Date) {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(apiKeys.id, id), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, before))));
  },

  /** True si ese identificador publico ya existe (colision al generar). */
  async tokenIdExists(tokenId: string): Promise<boolean> {
    const [row] = await db
      .select({ n: sql<number>`1` })
      .from(apiKeys)
      .where(eq(apiKeys.tokenId, tokenId))
      .limit(1);
    return row !== undefined;
  },
};
