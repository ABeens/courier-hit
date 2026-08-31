/**
 * Autogestion de llaves de API desde el PORTAL (docs/16 §3). Sesion con cookie,
 * como el resto del portal; la llave no sirve aqui (ver `requireApiKey`).
 *
 * Un solo permiso para las cuatro operaciones, `api_keys.manage`, que solo tiene
 * el rol cliente: emitir una credencial a nombre de un tercero es actuar como el.
 * El alcance es siempre el casillero de la sesion, nunca un id del cuerpo.
 */
import { Hono } from 'hono';
import { Permission, createApiKeySchema, rotateApiKeySchema } from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { zValidator } from '../../core/validator';
import { apiKeysService } from './api-keys.service';

export const apiKeysRoutes = new Hono<AppEnv>();

apiKeysRoutes.use('*', requireSession(), requirePermission(Permission.ApiKeysManage));

/** Las llaves del casillero, activas y revocadas. Sin paginar: son pocas. */
apiKeysRoutes.get('/', async (c) => {
  return c.json(await apiKeysService.list(c.get('session')));
});

/**
 * Emite una llave. 201 con el TOKEN COMPLETO dentro: es la unica respuesta del
 * sistema que lo contiene, y la pantalla tiene que decirlo.
 */
apiKeysRoutes.post('/', zValidator('json', createApiKeySchema), async (c) => {
  const created = await apiKeysService.create(c.get('session'), c.req.valid('json'));
  return c.json(created, 201);
});

/**
 * Rotacion: emite la sustituta y revoca esta. Es POST y no PATCH porque no edita
 * la llave, crea otra; lo que devuelve es un recurso nuevo.
 */
apiKeysRoutes.post('/:id/rotate', zValidator('json', rotateApiKeySchema), async (c) => {
  const created = await apiKeysService.rotate(c.get('session'), c.req.param('id'), c.req.valid('json'));
  return c.json(created, 201);
});

/**
 * Revocacion. DELETE aunque la fila no se borre: para quien llama, la llave deja
 * de existir. La fila se conserva porque es el historial de quien tuvo acceso, y
 * eso es justo lo que hay que poder consultar despues de un incidente.
 */
apiKeysRoutes.delete('/:id', async (c) => {
  return c.json(await apiKeysService.revoke(c.get('session'), c.req.param('id')));
});
