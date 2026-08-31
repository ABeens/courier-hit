/**
 * Esquemas y DTO de la AUTOGESTION de llaves: lo que el titular del casillero
 * usa desde el portal para crear, rotar y revocar sus credenciales (docs/16 §3).
 *
 * Nada de esto viaja por la API publica: son endpoints del portal, con sesion y
 * cookie. La llave se administra desde dentro; con la llave solo se consulta.
 */
import { z } from 'zod';
import type { ApiKeyEnvironment, ApiKeyRevokeReason } from './api-key';

/**
 * Nombre con el que el cliente reconoce la llave ("ERP", "tienda", "pruebas").
 * Es OBLIGATORIO y no un adorno: una lista de credenciales sin nombre no se
 * puede auditar, y la pregunta que hay que poder responder ante una fuga es
 * "quien tenia esta llave", no "cual era la tercera".
 */
export const apiKeyNameSchema = z
  .string()
  .trim()
  .min(2, 'Ponle un nombre a la llave (mínimo 2 caracteres).')
  .max(60, 'El nombre de la llave es demasiado largo.');

export const createApiKeySchema = z.object({ name: apiKeyNameSchema });
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/**
 * Rotar: se emite una llave nueva y la vieja queda revocada. El nombre es
 * opcional; sin el, la nueva hereda el de la que reemplaza (rotar no es
 * renombrar).
 */
export const rotateApiKeySchema = z.object({ name: apiKeyNameSchema.optional() });
export type RotateApiKeyInput = z.infer<typeof rotateApiKeySchema>;

/**
 * Una llave tal como la ve su dueño. NO lleva el secreto: despues de crearla, el
 * secreto no existe en ningun sitio del sistema (solo su hash), asi que esta
 * forma es todo lo que se puede devolver por mucho que se pregunte.
 */
export interface ApiKeyDto {
  id: string;
  name: string;
  environment: ApiKeyEnvironment;
  /** `hsk_live_kq7m...2fm`: lo suficiente para reconocerla, nada mas. */
  preview: string;
  createdAt: string;
  /** Ultima vez que se uso; `null` si nunca se ha usado. */
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: ApiKeyRevokeReason | null;
  /** Si nacio de una rotacion, la llave a la que reemplazo. */
  rotatedFromId: string | null;
  /** Derivado: `revokedAt === null`. Viaja para que la UI no repita la regla. */
  active: boolean;
}

/**
 * Respuesta del alta y de la rotacion: la llave mas el TOKEN COMPLETO, la unica
 * vez que se puede leer. La pantalla que lo recibe tiene que dejar claro que no
 * se va a volver a mostrar.
 */
export interface ApiKeyCreatedDto extends ApiKeyDto {
  token: string;
}

/** Lo que devuelve el listado del portal. Sin paginacion: son cinco como mucho. */
export interface ApiKeyListDto {
  items: ApiKeyDto[];
  /** Techo de llaves activas, para que la UI sepa cuando deshabilitar "Crear". */
  maxActive: number;
  /** Cuantas de las de arriba estan vivas. */
  activeCount: number;
}
