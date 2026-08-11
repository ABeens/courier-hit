/**
 * Validador de cuerpo / query / parametros. Envuelve `@hono/zod-validator` con
 * un unico proposito: que un fallo de validacion respete el contrato de errores
 * de la API, `{error:{code,message}}` (docs/04).
 *
 * El hook por defecto del paquete responde `c.json(result, 400)` con el ZodError
 * crudo, que al serializarse no lleva ni `code` ni `message`. La web lee
 * `data.error.message` (portal/lib/api.ts) y se queda con `undefined`, asi que el
 * usuario ve un error EN BLANCO: el peor desenlace posible, porque no dice que
 * corregir. La rama `ZodError` de `onError` no lo cubria porque el validador
 * nunca llega a lanzar, responde el mismo.
 *
 * Se devuelve el mensaje del PRIMER issue y no la lista entera: estas pantallas
 * muestran un solo renglon de error, y ese renglon tiene que ser accionable.
 */
import { type Hook, zValidator as baseValidator } from '@hono/zod-validator';
import type { Env } from 'hono';

type BaseValidator = typeof baseValidator;

const rejectInvalid: Hook<unknown, Env, string> = (result, c) => {
  if (result.success) return;
  const message = result.error.issues[0]?.message ?? 'Datos inválidos.';
  return c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400);
};

/**
 * Sustituto directo del `zValidator` del paquete: misma firma y mismas llamadas,
 * solo cambia el import. La asercion final es necesaria porque los genericos de
 * la firma original (`V extends I = I`) no se pueden reconstruir desde dentro del
 * envoltorio; los tipos que ven las rutas son los del paquete, sin recortar.
 */
export const zValidator = ((
  target: Parameters<BaseValidator>[0],
  schema: Parameters<BaseValidator>[1],
  hook: Parameters<BaseValidator>[2] = rejectInvalid,
) => baseValidator(target, schema, hook)) as BaseValidator;
