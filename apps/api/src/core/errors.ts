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
  idNumberInUse: () => new AppError('ID_NUMBER_IN_USE', 'Esa cédula ya tiene un casillero registrado.', 409),
  /**
   * Sin tarifa por defecto no podemos asignarle una al casillero nuevo, y un
   * casillero sin tarifa no se puede cotizar. Es un fallo de configuracion del
   * sistema, no del usuario: 500.
   */
  defaultRateMissing: () =>
    new AppError(
      'DEFAULT_CLIENT_RATE_MISSING',
      'No hay una tarifa por defecto configurada. Contacta a soporte.',
      500,
    ),
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

/** Errores del catalogo de servicios de costo (docs/manuales/flujo.md L1-20). */
export const CostServiceErrors = {
  notFound: () => new AppError('COST_SERVICE_NOT_FOUND', 'Servicio no encontrado.', 404),
  nameInUse: () => new AppError('COST_SERVICE_NAME_IN_USE', 'Ya existe un servicio con ese nombre.', 409),
  valueRequired: () =>
    new AppError('COST_SERVICE_VALUE_REQUIRED', 'Indica el valor por defecto para este tipo de servicio.', 400),
  currencyRequired: () =>
    new AppError('COST_SERVICE_CURRENCY_REQUIRED', 'Elige la moneda del monto por defecto.', 400),
  currencyNotAllowed: () =>
    new AppError('COST_SERVICE_CURRENCY_NOT_ALLOWED', 'Los servicios de Paquetería se cotizan en dólares (USD).', 400),
  invalidPercentage: () =>
    new AppError('COST_SERVICE_INVALID_PERCENTAGE', 'El porcentaje debe estar entre 0 y 100.', 400),
  valueTypeNotAllowed: () =>
    new AppError(
      'COST_SERVICE_VALUE_TYPE_NOT_ALLOWED',
      'Los servicios de Transporte y agenciamiento se cargan al recibir: su valor debe ser manual.',
      400,
    ),
};

/** Errores de los costos cargados sobre un tramite (docs/06-modulo-administrativo.md §3.3). */
export const CostErrors = {
  alreadyApproved: () =>
    new AppError(
      'COSTS_ALREADY_APPROVED',
      'Los costos de este trámite ya fueron aprobados y no se pueden modificar.',
      409,
    ),
  noLines: () =>
    new AppError('COSTS_NO_LINES', 'Agrega al menos una línea de costo antes de aprobar.', 400),
  notBillableState: () =>
    new AppError(
      'COSTS_NOT_BILLABLE_STATE',
      'Solo se pueden aprobar costos de un trámite en "Facturación en proceso".',
      409,
    ),
  /** El flow no tiene paso de facturacion: es un fallo de configuracion, no del usuario. */
  notBillable: () =>
    new AppError('COSTS_FLOW_NOT_BILLABLE', 'Este tipo de trámite no admite carga de costos.', 500),
};

/** Errores de las tarifas preferenciales de cliente. */
export const ClientRateErrors = {
  notFound: () => new AppError('CLIENT_RATE_NOT_FOUND', 'Tarifa no encontrada.', 404),
  nameInUse: () => new AppError('CLIENT_RATE_NAME_IN_USE', 'Ya existe una tarifa con ese nombre.', 409),
  defaultLocked: () =>
    new AppError('CLIENT_RATE_DEFAULT_LOCKED', 'No se puede eliminar la tarifa por defecto.', 409),
  defaultRequired: () =>
    new AppError(
      'CLIENT_RATE_DEFAULT_REQUIRED',
      'Debe existir una tarifa por defecto. Marca otra como predeterminada en su lugar.',
      409,
    ),
  paymentMethodRequired: () =>
    new AppError('CLIENT_RATE_PAYMENT_REQUIRED', 'La tarifa debe permitir al menos un medio de pago.', 400),
};

/**
 * Errores de la integracion con el proveedor Helga (docs/13 §3.5). El registro
 * de un casillero BLOQUEA si el proveedor falla: no queremos clientes que
 * existan de nuestro lado y no del suyo.
 */
export const ProviderErrors = {
  unavailable: () =>
    new AppError(
      'PROVIDER_UNAVAILABLE',
      'No pudimos crear tu casillero con el operador en Miami. Intenta de nuevo en unos minutos.',
      503,
    ),
  validation: (detail?: string) =>
    new AppError(
      'PROVIDER_VALIDATION',
      detail
        ? `El operador en Miami rechazó los datos: ${detail}`
        : 'El operador en Miami rechazó los datos del casillero.',
      502,
    ),
  forbidden: () =>
    new AppError('PROVIDER_FORBIDDEN', 'El operador en Miami rechazó la conexión (lista blanca).', 502),
  unauthenticated: () =>
    new AppError('PROVIDER_UNAUTHENTICATED', 'No pudimos autenticarnos con el operador en Miami.', 502),
};

/** Errores del modulo de tramites (docs/manuales/flujo.md L30-145). */
export const ShipmentErrors = {
  notFound: () => new AppError('SHIPMENT_NOT_FOUND', 'Trámite no encontrado.', 404),
  clientNotFound: () => new AppError('SHIPMENT_CLIENT_NOT_FOUND', 'El cliente indicado no existe.', 404),
  /**
   * El casillero de la sesion no se pudo resolver. Es un fallo de datos (usuario
   * con rol client sin perfil de casillero), no del cliente: 500.
   */
  missingClientProfile: () =>
    new AppError(
      'CLIENT_PROFILE_MISSING',
      'Tu cuenta no tiene un casillero asociado. Contacta a soporte.',
      500,
    ),
  trackingInUse: (code: string) =>
    new AppError(
      'SHIPMENT_TRACKING_IN_USE',
      `Ya existe un trámite activo con ese tracking (${code}).`,
      409,
    ),
  fieldNotForType: () =>
    new AppError(
      'SHIPMENT_FIELD_NOT_FOR_TYPE',
      'Alguno de los datos enviados no aplica a este tipo de trámite.',
      400,
    ),
};

/** Errores de los anuncios del portal (docs/manuales/roles.md §3). */
export const AnnouncementErrors = {
  notFound: () => new AppError('ANNOUNCEMENT_NOT_FOUND', 'Anuncio no encontrado.', 404),
  invalidRange: () =>
    new AppError(
      'ANNOUNCEMENT_INVALID_RANGE',
      'El fin de la vigencia debe ser posterior al inicio.',
      400,
    ),
};

/** Errores de la definicion de rutas (panel admin, permiso routes.manage). */
export const RouteErrors = {
  notFound: () => new AppError('DISTRICT_ROUTE_NOT_FOUND', 'El distrito no tiene una ruta asignada.', 404),
  districtNotFound: () => new AppError('DISTRICT_NOT_FOUND', 'Distrito no encontrado.', 404),
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
