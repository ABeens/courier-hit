/**
 * Barrera de la API PUBLICA: resuelve la llave que viene en la cabecera y deja
 * en el contexto el casillero al que pertenece. 401/403 si no pasa.
 *
 * Es el equivalente de `requireSession` para la otra puerta del sistema, y las
 * dos son EXCLUYENTES a proposito:
 *
 *   - La cookie de sesion NO autentica nada bajo `/api/v1`. Si lo hiciera, un
 *     sitio ajeno podria hacer que el navegador de un cliente logueado ejecutara
 *     operaciones contra la API publica solo con que este visitara una pagina
 *     (CSRF): la API publica no tiene formularios ni token anti-CSRF que oponer.
 *   - La llave no autentica nada fuera de `/api/v1`. Una llave que abriera el
 *     portal daria acceso a pantallas y datos que el contrato publico no expone.
 *
 * El alcance tampoco viaja nunca en la peticion: el casillero sale de la llave,
 * igual que en el portal sale de la cookie (docs/04 §6).
 */
import { createMiddleware } from 'hono/factory';
import { config } from '../config';
import { PublicApiErrors } from '../errors';
import type { AppEnv } from '../http';
import { apiKeysService } from '../../modules/api-keys/api-keys.service';

/**
 * Saca la llave de la peticion. Se aceptan las DOS formas habituales:
 *
 *   - `Authorization: Bearer <llave>`, que es la estandar y la que documentamos;
 *   - `X-API-Key: <llave>`, porque hay clientes (algunos ERP, algunas
 *     herramientas de automatizacion sin codigo) que no dejan fijar
 *     `Authorization` a mano, y negarles la entrada no compra ninguna seguridad.
 *
 * La query string NO se admite: ahi la llave acabaria en los logs de acceso, en
 * el historial del navegador y en la cabecera `Referer` de cualquier salto.
 */
function readKey(header: (name: string) => string | undefined): string | null {
  const authorization = header('authorization');
  if (authorization) {
    const [scheme, ...rest] = authorization.trim().split(/\s+/);
    if (scheme?.toLowerCase() === 'bearer' && rest.length > 0) return rest.join(' ');
    // Un `Authorization` que no es Bearer no se ignora en silencio: quien lo
    // mando cree que se esta autenticando.
    return null;
  }
  return header('x-api-key')?.trim() || null;
}

export function requireApiKey() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!config.PUBLIC_API_ENABLED) throw PublicApiErrors.disabled();

    const raw = readKey((name) => c.req.header(name));
    if (!raw) throw PublicApiErrors.keyMissing();

    const check = await apiKeysService.verify(raw);
    if (!check.ok) {
      if (check.reason === 'revoked') throw PublicApiErrors.keyRevoked();
      if (check.reason === 'inactive') throw PublicApiErrors.accountInactive();
      throw PublicApiErrors.keyInvalid();
    }

    c.set('apiClient', {
      keyId: check.keyId,
      clientId: check.clientId,
      clientCode: check.clientCode,
    });
    await next();
  });
}
