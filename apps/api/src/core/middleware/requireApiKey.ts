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
import { API_KEY_HEADER } from '@courier/shared';
import { config } from '../config';
import { PublicApiErrors } from '../errors';
import type { AppEnv } from '../http';
import { apiKeysService } from '../../modules/api-keys/api-keys.service';

/**
 * Saca la llave de la peticion. Se aceptan las DOS formas habituales:
 *
 *   - `X-API-Key: <llave>`, la nuestra;
 *   - `Authorization: Bearer <llave>`, la estandar.
 *
 * Se mira PRIMERO la nuestra, y esa prioridad no es un capricho. `Authorization`
 * la escribe media herramienta por su cuenta: Postman la manda en cuanto hay
 * algo configurado en su pestaña de autenticacion, y los gateways y varios ERP
 * la inyectan sin avisar. Cuando ganaba `Authorization`, la llave puesta a mano
 * en `X-API-Key` no se miraba nunca y el cliente recibia un 401 con la llave
 * correcta delante, sin nada en la respuesta que apuntara a la cabecera de mas.
 * `X-API-Key` no la pone nadie por accidente: si esta, es la que se quiso mandar.
 *
 * Un `Authorization` que no es Bearer (y sin `X-API-Key` que valga) no se ignora
 * en silencio: quien lo mando cree que se esta autenticando.
 *
 * La query string NO se admite: ahi la llave acabaria en los logs de acceso, en
 * el historial del navegador y en la cabecera `Referer` de cualquier salto.
 */
function readKey(header: (name: string) => string | undefined): string | null {
  const own = header(API_KEY_HEADER)?.trim();
  if (own) return own;

  const authorization = header('authorization');
  if (authorization) {
    const [scheme, ...rest] = authorization.trim().split(/\s+/);
    if (scheme?.toLowerCase() === 'bearer' && rest.length > 0) return rest.join(' ');
    return null;
  }
  return null;
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
