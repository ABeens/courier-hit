/**
 * Barrera de la bandera POR CASILLERO `clients.api_access_enabled` (docs/16 §3):
 * sin ella encendida, el cliente no puede emitir, rotar ni revocar llaves.
 *
 * No sustituye al permiso, se aplica ADEMAS de `api_keys.manage`. Son dos
 * preguntas distintas: el permiso responde "¿a este ROL le toca gestionar
 * llaves?" (y la respuesta es la misma para todos los clientes), y esto responde
 * "¿a ESTE casillero se le habilito la API?", que se decide cliente por cliente
 * y la enciende un administrador.
 *
 * Va aqui y no solo en el portal porque ocultar no es negar: la pantalla "API"
 * desaparece del menu con la bandera apagada, pero quien conozca la URL del
 * endpoint llegaria igual (docs/06 §8).
 *
 * El estado sale de la SESION, que se reconstruye en cada peticion leyendo el
 * casillero (`authService.buildSession`): apagar la bandera corta la autogestion
 * en la siguiente peticion, sin esperar a que caduque nada.
 */
import { createMiddleware } from 'hono/factory';
import { ApiKeyErrors } from '../errors';
import type { AppEnv } from '../http';

export function requireApiAccess() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.get('session')?.apiAccess !== true) throw ApiKeyErrors.accessDisabled();
    await next();
  });
}
