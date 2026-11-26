/**
 * Llaves de los webhooks de Helga: una por cuenta Miami.
 *
 * Mismo criterio que las llaves de la API publica (`api-keys.service.ts`): se
 * guarda solo el SHA-256, se compara en tiempo constante, y el hash rapido es a
 * proposito (la llave son bytes aleatorios nuestros, no una contrasena).
 *
 * Viven en la configuracion (`HELGA_WEBHOOK_KEYS`, Parameter Store) y no en una
 * tabla: son un punado, las emite una persona con un script, y la cuenta
 * principal tampoco esta en la base (vive en `HELGA_ACCOUNTS`).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../../core/config';

export function hashWebhookKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Cuenta Miami a la que pertenece la llave, o `null` si no es de ninguna.
 * Recorre TODAS las entradas aunque encuentre antes: lo que tarda no dice cual
 * acerto.
 */
export function accountForWebhookKey(token: string): string | null {
  const presented = Buffer.from(hashWebhookKey(token), 'utf8');
  let found: string | null = null;
  for (const entry of config.HELGA_WEBHOOK_KEYS) {
    const stored = Buffer.from(entry.hash, 'utf8');
    if (stored.length === presented.length && timingSafeEqual(stored, presented) && !found) {
      found = entry.account;
    }
  }
  return found;
}

/**
 * Saca la llave de la peticion: `Authorization: Bearer <llave>` (lo que propone
 * la especificacion) o `X-API-Key` (la alternativa que tambien admite).
 */
export function readWebhookKey(header: (name: string) => string | undefined): string | null {
  const own = header('x-api-key')?.trim();
  if (own) return own;
  const authorization = header('authorization')?.trim();
  if (!authorization) return null;
  const [scheme, ...rest] = authorization.split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) return null;
  return rest.join(' ');
}
