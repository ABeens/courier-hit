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
  /**
   * Cambio de correo bloqueado a proposito (temporal): sin transporte de correo
   * real ni pantalla de verificacion fuera del registro, cambiarlo dejaria al
   * cliente sin verificar, sin sesion y sin forma de recuperar la cuenta.
   * TODO(correo): quitar al sumar la verificacion al flujo de perfil.
   */
  emailChangeDisabled: () =>
    new AppError(
      'EMAIL_CHANGE_DISABLED',
      'Por ahora el correo no se puede cambiar desde el portal. Contacta a soporte.',
      403,
    ),
  userInactive: () => new AppError('USER_INACTIVE', 'La cuenta está deshabilitada.', 403),
  emailNotVerified: () => new AppError('EMAIL_NOT_VERIFIED', 'Debes verificar tu correo antes de ingresar.', 403),
  /**
   * El casillero aun no esta enlazado con el proveedor (Helga). El cliente no
   * ingresa hasta que la reconciliacion lo deje `synced`. Solo aplica con la
   * integracion encendida.
   */
  accountPendingVerification: () =>
    new AppError(
      'ACCOUNT_PENDING_VERIFICATION',
      'Estamos verificando tu información. Te avisaremos por correo cuando tu cuenta esté lista para ingresar.',
      403,
    ),
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
  notApproved: () =>
    new AppError(
      'COSTS_NOT_APPROVED',
      'Los costos de este trámite no están aprobados: no hay nada que reversar.',
      409,
    ),
  /**
   * Espejo de `notBillableState`. Reversar mas adelante dejaria al cliente con el
   * boton de pagar sobre una factura recien borrada: primero se corrige el estado.
   */
  notReversibleState: () =>
    new AppError(
      'COSTS_NOT_REVERSIBLE_STATE',
      'Solo se puede reversar la factura de un trámite en "Facturación en proceso". Corrige antes el estado del trámite.',
      409,
    ),
  /**
   * Reversar con dinero ya recibido dejaria al cliente pagando contra una factura
   * que dejo de existir. Primero se resuelve el pago, despues se desarma el cobro.
   */
  settledCannotReverse: () =>
    new AppError(
      'COSTS_SETTLED_CANNOT_REVERSE',
      'El trámite ya tiene pagos confirmados. Resuelve los pagos antes de reversar la factura.',
      409,
    ),
  /**
   * La tasa es un valor general que solo fija el administrador (en Configuración),
   * y no hay ninguna vigente: ni guardada en el trámite ni fijada en el sistema.
   * Lo que publica el BCCR no cuenta, es solo referencia. Guardar sin tasa dejaría
   * líneas sin el testigo de conversión (regla M5), así que se para aquí.
   */
  noExchangeRate: () =>
    new AppError(
      'COSTS_NO_EXCHANGE_RATE',
      'No hay tasa de cambio vigente. Pide a un administrador que registre la tasa del día antes de cargar costos.',
      409,
    ),
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
 * Errores de la integracion con el proveedor Helga (docs/13 §3.5).
 *
 * El registro NO bloquea si el proveedor falla: el casillero nace igual, marcado
 * `pending`/`failed`, y el robot lo reintenta. La puerta de "no queremos clientes
 * que existan de nuestro lado y no del suyo" vive en el login (`auth.service`).
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

/**
 * Errores de la correccion MANUAL del enlace de un casillero (panel de
 * administracion). Distintos de `ProviderErrors`: aqui el proveedor no
 * interviene, el que se equivoca es quien corrige.
 */
export const ProviderLinkErrors = {
  unchanged: () =>
    new AppError('PROVIDER_LINK_UNCHANGED', 'Los datos enviados son los que ya tenía el casillero.', 409),
  needsHelgaId: () =>
    new AppError(
      'PROVIDER_LINK_NEEDS_HELGA_ID',
      'No se puede marcar el casillero como enlazado sin el id de destinatario de Helga.',
      409,
    ),
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
  /**
   * El campo enviado no admite edicion con el tramite en su estado actual (la
   * maquina de estados lo excluye de `editable`). 409: no es un dato invalido,
   * es que el momento del tramite no permite cambiarlo.
   */
  fieldNotEditableInState: (state: string) =>
    new AppError(
      'SHIPMENT_FIELD_NOT_EDITABLE',
      `Alguno de los datos enviados no se puede modificar con el trámite en "${state}".`,
      409,
    ),
  /**
   * El peso alimenta la factura y esta ya fue congelada (costos aprobados). No se
   * corrige por PATCH: hay que reversar los costos primero. 409.
   */
  weightLockedAfterInvoice: () =>
    new AppError(
      'SHIPMENT_WEIGHT_LOCKED',
      'El peso no se puede cambiar: la factura ya fue aprobada. Reversa los costos del trámite para corregirlo.',
      409,
    ),
};

/**
 * Errores de una transicion de estado. La maquina de estados de @courier/shared
 * decide si el movimiento es legal; estos son los "no" que puede devolver.
 */
export const TransitionErrors = {
  notAllowed: (from: string, to: string) =>
    new AppError('TRANSITION_NOT_ALLOWED', `Un trámite en "${from}" no puede pasar a "${to}".`, 409),
  requiresComment: () =>
    new AppError('TRANSITION_REQUIRES_COMMENT', 'Indica el motivo para avanzar a este estado.', 400),
  requiresInvoiceAmount: () =>
    new AppError(
      'TRANSITION_REQUIRES_INVOICE',
      'El trámite necesita el monto de factura aprobado antes de avanzar.',
      409,
    ),
  requiresConfirmedPayment: () =>
    new AppError(
      'TRANSITION_REQUIRES_PAYMENT',
      'El trámite no puede salir a entrega sin el pago confirmado.',
      409,
    ),
  /** La correccion solo alcanza estados de la maquina del propio tramite. */
  stateNotInFlow: (state: string) =>
    new AppError(
      'TRANSITION_STATE_NOT_IN_FLOW',
      `"${state}" no es un estado de este tipo de trámite.`,
      409,
    ),
  sameState: () =>
    new AppError('TRANSITION_SAME_STATE', 'El trámite ya está en ese estado.', 409),
};

/** Errores del modulo de pagos (Parte 2 "Pagos" y Parte 3 "Informacion de Pago"). */
export const PaymentErrors = {
  notFound: () => new AppError('PAYMENT_NOT_FOUND', 'Pago no encontrado.', 404),
  notPayableState: () =>
    new AppError(
      'PAYMENT_NOT_PAYABLE_STATE',
      'Solo se puede pagar un trámite en "En bodega - Pendiente pago".',
      409,
    ),
  noInvoice: () =>
    new AppError('PAYMENT_NO_INVOICE', 'El trámite todavía no tiene un monto de factura aprobado.', 409),
  alreadySettled: () =>
    new AppError('PAYMENT_ALREADY_SETTLED', 'Este trámite ya está pagado.', 409),
  alreadyResolved: () =>
    new AppError('PAYMENT_ALREADY_RESOLVED', 'Este pago ya fue confirmado o rechazado.', 409),
  methodNotAllowed: () =>
    new AppError(
      'PAYMENT_METHOD_NOT_ALLOWED',
      'Tu tarifa no admite ese medio de pago. Elige otro.',
      403,
    ),
  /**
   * La pasarela no esta configurada. Es un fallo de configuracion del sistema, no
   * del cliente: 503, y la web ni siquiera deberia haber ofrecido la opcion.
   */
  gatewayUnavailable: () =>
    new AppError(
      'PAYMENT_GATEWAY_UNAVAILABLE',
      'El pago con tarjeta no está disponible en este momento. Usa depósito bancario.',
      503,
    ),
  /**
   * La pasarela esta configurada pero fallo (cayo, tardo demasiado, respondio algo
   * que no entendemos). Se separa de `gatewayUnavailable` porque aqui el cliente SI
   * puede reintentar: el problema es del momento, no de la configuracion. El
   * detalle real queda en el log; al pagador no le sirve y puede filtrar datos de
   * la cuenta.
   */
  gatewayError: () =>
    new AppError(
      'PAYMENT_GATEWAY_ERROR',
      'No pudimos comunicarnos con la pasarela de pago. Intenta de nuevo en unos minutos.',
      502,
    ),
  /** El flujo simulado solo existe fuera de produccion (ver `onvoMode`). */
  simulationNotAllowed: () =>
    new AppError('PAYMENT_SIMULATION_NOT_ALLOWED', 'La simulación de pagos no está habilitada.', 404),
  receiptRequired: () =>
    new AppError('PAYMENT_RECEIPT_REQUIRED', 'Adjunta el comprobante del depósito.', 400),
  /**
   * No se pudo determinar la tasa de cambio a congelar con el pago. Guardar el
   * monto sin ella violaria la regla M5, asi que se prefiere no cobrar. Es un
   * fallo de configuracion (factura sin componente en dolares y sin tasa global
   * fijada), no del cliente: 503.
   */
  exchangeRateUnavailable: () =>
    new AppError(
      'PAYMENT_EXCHANGE_RATE_UNAVAILABLE',
      'No pudimos determinar la tasa de cambio del pago. Intenta más tarde o contacta a soporte.',
      503,
    ),
};

/** Errores del modulo de entregas (Parte 5, rol Mensajeria). */
export const DeliveryErrors = {
  notInRoute: () =>
    new AppError(
      'DELIVERY_NOT_IN_ROUTE',
      'Solo se puede registrar la entrega de un trámite en "En ruta de entrega".',
      409,
    ),
  photoRequired: () =>
    new AppError('DELIVERY_PHOTO_REQUIRED', 'Adjunta la foto del paquete entregado.', 400),
};

/** Errores de la recepcion en bodega (Parte 4, "Recepción de Paquete"). */
export const ReceptionErrors = {
  /**
   * El tracking no existe en nuestro sistema. NO es un 404 seco: el manual pide
   * que ese caso derive al alta manual, asi que el codigo es estable y la web
   * ramifica sobre el para abrir el formulario.
   */
  unknownTracking: (tracking: string) =>
    new AppError(
      'RECEPTION_UNKNOWN_TRACKING',
      `No hay ningún trámite con el tracking ${tracking}. Ingrésalo manualmente.`,
      404,
    ),
  alreadyReceived: (state: string) =>
    new AppError('RECEPTION_ALREADY_RECEIVED', `El trámite ya está en "${state}".`, 409),
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
