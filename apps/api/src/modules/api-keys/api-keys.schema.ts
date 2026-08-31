/**
 * Tabla Drizzle de las llaves de API (docs/16 §5).
 *
 * Una llave pertenece a un CASILLERO, no a un usuario: es la credencial del
 * cliente como empresa, y tiene que sobrevivir a que cambie la persona que la
 * creo. `created_by_user_id` queda solo como rastro de auditoria, y por eso es
 * `set null`: borrar al empleado que la emitio no puede tumbar la integracion.
 *
 * Del secreto NO se guarda nada reversible: solo `token_hash`. Ver
 * `api-keys.service.ts` para el porque del hash rapido.
 */
import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { API_KEY_ENVIRONMENTS, API_KEY_REVOKE_REASON_VALUES } from '@courier/shared';
import { clients, users } from '../auth/auth.schema';

export const apiKeyEnvironmentEnum = pgEnum('api_key_environment', API_KEY_ENVIRONMENTS);
export const apiKeyRevokeReasonEnum = pgEnum('api_key_revoke_reason', API_KEY_REVOKE_REASON_VALUES);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    /** Nombre que le puso el cliente: "ERP", "tienda", "pruebas". */
    name: text('name').notNull(),
    /**
     * Entorno al que pertenece. Se COMPRUEBA en cada peticion contra el del
     * servidor: una llave `test` no abre produccion aunque el hash cuadre.
     */
    environment: apiKeyEnvironmentEnum('environment').notNull(),
    /**
     * Parte publica de la llave, en claro. Es por donde se encuentra la fila: sin
     * ella habria que comparar el hash contra todas las llaves vivas del sistema
     * en cada peticion.
     */
    tokenId: text('token_id').notNull(),
    /** SHA-256 en hexadecimal del token COMPLETO. Nunca el token. */
    tokenHash: text('token_hash').notNull(),
    /** Ultimos caracteres del secreto, para que el dueño reconozca su llave. */
    lastFour: text('last_four').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Ultimo uso. Es la unica forma de responder "esta llave, ¿la sigue usando
     * alguien?", que es la pregunta previa a revocar una que sobra. Se escribe
     * con parsimonia (ver `TOUCH_INTERVAL_MS`): una escritura por peticion
     * convertiria cada consulta de solo lectura en un UPDATE.
     */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: apiKeyRevokeReasonEnum('revoked_reason'),
    /**
     * Si nacio de una rotacion, la llave a la que reemplazo. Sin clave foranea a
     * proposito: es una autorreferencia (obliga a anotar el tipo de la columna a
     * mano) y no compra integridad util, porque una llave no se borra nunca.
     */
    rotatedFromId: uuid('rotated_from_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * Unico y no a secas: el identificador publico ES la clave de busqueda de la
     * autenticacion. Dos filas con el mismo `token_id` harian que `limit 1`
     * eligiera una de las dos al azar, o sea que una llave revocada podria
     * autenticar en lugar de la viva.
     */
    uniqueIndex('api_keys_token_id_idx').on(t.tokenId),
    /** La lista del portal: las llaves de un casillero, de la mas nueva a la mas vieja. */
    index('api_keys_client_idx').on(t.clientId, t.createdAt),
    /**
     * Solo las ACTIVAS. Es lo que cuenta el tope de llaves por casillero y lo que
     * mira la ficha del cliente; parcial porque las revocadas no se borran nunca
     * (son el historial) y no tienen por que engordar el indice.
     */
    index('api_keys_active_idx')
      .on(t.clientId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKeyRow = typeof apiKeys.$inferInsert;
