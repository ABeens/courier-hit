/**
 * Barrera de la bandera `MIAMI_LINK_ENABLED`: con el enlace con Miami apagado,
 * la pantalla no existe para el portal y sus endpoints tampoco responden. Va
 * junto a `requirePermission` porque el portal solo oculta el menu, y ocultar no
 * es negar: quien conozca la URL de la API llegaria igual (docs/06 §8).
 *
 * No sustituye al permiso: se aplica ADEMAS de `config.manage`. Aqui se
 * pregunta "¿esta funcion esta desplegada?", alli "¿este rol puede usarla?".
 */
import { createMiddleware } from 'hono/factory';
import { miamiLinkEnabled } from '../config';
import { AuthErrors } from '../errors';
import type { AppEnv } from '../http';

export function requireMiamiLink() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!miamiLinkEnabled) {
      throw AuthErrors.forbidden('El enlace con Miami está desactivado en este despliegue.');
    }
    await next();
  });
}
