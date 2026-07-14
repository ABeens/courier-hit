/**
 * Contrato de errores unico (docs/02-api.md §5):
 *   { "error": { "code": "...", "message": "..." } }
 * `code` es estable en MAYUSCULAS (el cliente ramifica sobre el); `message` es
 * texto humano en es-CO. Errores no controlados caen a INTERNAL_ERROR sin
 * filtrar detalle.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: ContentfulStatusCode = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Errores del dominio de autenticacion. */
export const AuthErrors = {
  unauthorized: (message = 'No autenticado.') => new AppError('UNAUTHORIZED', message, 401),
  invalidCredentials: () => new AppError('INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.', 401),
  forbidden: (message = 'No tienes permiso para esta acción.') => new AppError('FORBIDDEN', message, 403),
  emailInUse: () => new AppError('EMAIL_IN_USE', 'Ese correo ya está registrado.', 409),
  userInactive: () => new AppError('USER_INACTIVE', 'La cuenta está deshabilitada.', 403),
  emailNotVerified: () => new AppError('EMAIL_NOT_VERIFIED', 'Debes verificar tu correo antes de ingresar.', 403),
  invalidCode: () => new AppError('INVALID_CODE', 'El código es incorrecto o expiró.', 400),
  invalidToken: () => new AppError('INVALID_TOKEN', 'El enlace es inválido o expiró.', 400),
};

/** Errores de la gestion de staff (docs/roles.md §1.3). */
export const UserErrors = {
  notFound: () => new AppError('USER_NOT_FOUND', 'Usuario no encontrado.', 404),
  lastAdmin: () =>
    new AppError('LAST_ADMIN', 'No puedes deshabilitar ni cambiar el rol del último administrador activo.', 409),
};

export function onError(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  if (err instanceof ZodError) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Datos inválidos.' } }, 400);
  }
  console.error('[api] error no controlado:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Error interno.' } }, 500);
}
