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
   * La referencia publicada no cuenta, es solo informativa. Guardar sin tasa dejaría
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

/** Errores del casillero visto por su propio titular (portal del cliente). */
export const ClientErrors = {
  /**
   * La direccion de entrega se puede cambiar, pero no con tramites en curso: el
   * distrito determina la ruta de reparto y tanto la hoja del mensajero como la
   * proforma leen la direccion del casillero EN VIVO (no una copia congelada en
   * el tramite). Moverla a mitad de camino le cambiaria el destino a un paquete
   * que quiza ya va en la ruta equivocada.
   *
   * 409 y no 403: no es falta de permiso sino un conflicto con el estado actual,
   * y se resuelve solo cuando esos tramites se entreguen.
   */
  addressLockedByActiveShipments: (activeCount: number) =>
    new AppError(
      'CLIENT_ADDRESS_LOCKED',
      activeCount === 1
        ? 'No puedes cambiar tu dirección de entrega mientras tengas un trámite en curso. Podrás editarla cuando se entregue; si es urgente, contáctanos.'
        : `No puedes cambiar tu dirección de entrega mientras tengas trámites en curso (${activeCount}). Podrás editarla cuando se entreguen; si es urgente, contáctanos.`,
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
  /** Se pidio el documento de un tramite que no tiene ninguno adjunto. */
  documentMissing: () =>
    new AppError('SHIPMENT_DOCUMENT_MISSING', 'El trámite no tiene documento adjunto.', 404),

  // --- Sala de control: paquetes sin dueño (docs/06 §9) ---
  /**
   * Se intento operar el proceso sobre un paquete que todavia no tiene dueño:
   * avanzarlo, cotizarlo, cobrarlo o entregarlo. Las cuatro cosas necesitan saber
   * a quien, asi que el paquete se queda quieto hasta que la sala de control le
   * asigne casillero. 409: no falta un dato del cuerpo, falta un paso previo.
   */
  unassigned: () =>
    new AppError(
      'SHIPMENT_UNASSIGNED',
      'El paquete todavía no tiene dueño. Asígnale un casillero desde la sala de control antes de continuar.',
      409,
    ),
  /** Se llamo a una operacion de paquete sin dueño sobre un tramite que ya lo tiene. */
  alreadyAssigned: (clientCode: string) =>
    new AppError('SHIPMENT_ALREADY_ASSIGNED', `El paquete ya pertenece al casillero ${clientCode}.`, 409),
  /** Reasignar al mismo casillero que ya lo tiene: no hay nada que cambiar. */
  sameOwner: () =>
    new AppError('SHIPMENT_SAME_OWNER', 'El paquete ya pertenece a ese casillero.', 409),
  /**
   * Cambiar de dueño con la factura ya congelada moveria una deuda de un cliente
   * a otro sin que ninguna de las dos cuentas se entere. Se reversan los costos
   * primero, que es el acto que si deja rastro contable.
   */
  ownerLockedAfterInvoice: () =>
    new AppError(
      'SHIPMENT_OWNER_LOCKED',
      'No se puede cambiar el dueño: la factura ya fue aprobada. Reversa los costos del trámite primero.',
      409,
    ),
  /** Hay abonos registrados a nombre del dueño actual; cambiarlo dejaria pagos huerfanos. */
  ownerLockedByPayments: () =>
    new AppError(
      'SHIPMENT_OWNER_LOCKED_PAYMENTS',
      'No se puede cambiar el dueño: el trámite ya tiene pagos registrados a nombre del cliente actual.',
      409,
    ),
  /** El tramite esta archivado: primero se restaura, despues se opera. */
  discarded: () =>
    new AppError(
      'SHIPMENT_DISCARDED',
      'El paquete está descartado. Restáuralo desde la sala de control para volver a trabajarlo.',
      409,
    ),
  /** Se pidio restaurar algo que no estaba descartado. */
  notDiscarded: () =>
    new AppError('SHIPMENT_NOT_DISCARDED', 'El paquete no está descartado.', 409),
  /**
   * Descartar es la salida de un paquete que nunca tuvo dueño. Uno que ya lo
   * tiene es un tramite normal y se enmienda por el flujo (corregir estado,
   * reversar costos), no archivandolo por la puerta de atras.
   */
  discardOnlyUnassigned: () =>
    new AppError(
      'SHIPMENT_DISCARD_ONLY_UNASSIGNED',
      'Solo se pueden descartar paquetes sin dueño. Este ya tiene casillero asignado.',
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
  /**
   * Ya hay un abono que cubre el saldo esperando validacion. No es un error del
   * cliente —hizo lo que tenia que hacer— sino un conflicto con el estado del
   * tramite: 409, y el mensaje dice que espere en vez de sugerirle reintentar.
   */
  inValidation: () =>
    new AppError(
      'PAYMENT_IN_VALIDATION',
      'Ya recibimos un pago de este trámite y lo estamos validando. Te avisaremos apenas quede confirmado.',
      409,
    ),
  alreadyResolved: () =>
    new AppError('PAYMENT_ALREADY_RESOLVED', 'Este pago ya fue confirmado o rechazado.', 409),
  /**
   * Hay un cobro con tarjeta anterior que la pasarela NO deja cancelar, o sea que
   * ese cargo va en camino. Abrir otro formulario cobraria dos veces el mismo
   * saldo, asi que se pide esperar el desenlace del primero. 409 por lo mismo que
   * `inValidation`: no es un error de quien pide, es el estado del tramite.
   */
  cardAttemptInFlight: () =>
    new AppError(
      'PAYMENT_CARD_ATTEMPT_IN_FLIGHT',
      'Tu cobro anterior con tarjeta todavía se está procesando. Espera unos segundos y vuelve a intentarlo.',
      409,
    ),
  methodNotAllowed: () =>
    new AppError(
      'PAYMENT_METHOD_NOT_ALLOWED',
      'Tu tarifa no admite ese medio de pago. Elige otro.',
      403,
    ),
  /**
   * La cuenta elegida no es de las que ese tramite admite (Paqueteria solo
   * recibe depositos en las cuentas de dolares). 403 y no 400: el valor es
   * valido, lo que no esta permitido es usarlo en ESTE tramite.
   */
  bankAccountNotAllowed: () =>
    new AppError(
      'PAYMENT_BANK_ACCOUNT_NOT_ALLOWED',
      'Esa cuenta no está disponible para este trámite. Elige una de las que se muestran.',
      403,
    ),
  /** Solo un deposito tiene cuenta bancaria; un cobro con tarjeta no. */
  bankAccountNotApplicable: () =>
    new AppError(
      'PAYMENT_BANK_ACCOUNT_NOT_APPLICABLE',
      'Solo los pagos por depósito bancario tienen cuenta.',
      409,
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
   * El HAWB (LES) no existe en nuestro sistema. NO es un 404 seco: el manual pide
   * que ese caso derive al alta manual, asi que el codigo es estable y la web
   * ramifica sobre el para abrir el formulario.
   */
  unknownHawb: (hawb: string) =>
    new AppError(
      'RECEPTION_UNKNOWN_HAWB',
      `No hay ningún trámite con el LES (HAWB) ${hawb}. Ingrésalo manualmente.`,
      404,
    ),
  /**
   * El HAWB no tiene indice unico en la BD, asi que dos tramites activos pueden
   * quedar con el mismo. Recibir uno al azar movería de estado el trámite
   * equivocado, asi que la recepcion se detiene y lo deriva a un humano.
   */
  ambiguousHawb: (hawb: string) =>
    new AppError(
      'RECEPTION_AMBIGUOUS_HAWB',
      `Hay más de un trámite activo con el LES (HAWB) ${hawb}. Resuélvelo desde Trámites antes de recibirlo.`,
      409,
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

/**
 * Errores de la AUTOGESTION de llaves de API desde el portal (docs/16 §3).
 * Los de la API publica —los que ve un integrador— viven aparte, en
 * `PublicApiErrors`: son otra audiencia y otro contrato.
 */
export const ApiKeyErrors = {
  /**
   * 404 tambien cuando la llave existe pero es de otro casillero. No se distingue
   * a proposito: confirmar la existencia de una credencial ajena ya es filtrar.
   */
  notFound: () => new AppError('API_KEY_NOT_FOUND', 'Llave no encontrada.', 404),
  alreadyRevoked: () =>
    new AppError('API_KEY_ALREADY_REVOKED', 'Esa llave ya estaba revocada.', 409),
  /**
   * El tope existe por la rotacion (hacen falta dos vivas para cambiar la
   * credencial sin cortar el servicio); pasarlo significa que sobran llaves, no
   * que falte cupo. Por eso el mensaje empuja a revocar, no a pedir mas.
   */
  tooMany: (max: number) =>
    new AppError(
      'API_KEY_LIMIT_REACHED',
      `Ya tienes ${max} llaves activas, el maximo. Revoca una que no uses antes de crear otra.`,
      409,
    ),
};

/**
 * Errores de la API PUBLICA (`/api/v1`). Van aparte del resto porque su lector
 * no es el portal sino el sistema de un tercero: los mensajes explican que hacer
 * (rotar la llave, esperar, revisar el casillero) y no describen el estado
 * interno del sistema.
 */
export const PublicApiErrors = {
  disabled: () =>
    new AppError(
      'PUBLIC_API_DISABLED',
      'La API publica esta deshabilitada en este momento.',
      503,
    ),
  keyMissing: () =>
    new AppError(
      'API_KEY_MISSING',
      'Falta la llave de API. Envíala en la cabecera "Authorization: Bearer <llave>" o en "X-API-Key".',
      401,
    ),
  keyInvalid: () =>
    new AppError('API_KEY_INVALID', 'La llave de API no es válida.', 401),
  keyRevoked: () =>
    new AppError(
      'API_KEY_REVOKED',
      'Esa llave fue revocada. Genera una nueva desde tu portal, en "API".',
      401,
    ),
  accountInactive: () =>
    new AppError(
      'ACCOUNT_INACTIVE',
      'La cuenta asociada a esta llave está deshabilitada. Contacta a soporte.',
      403,
    ),
  /**
   * Se pregunto por un casillero que no es el de la llave. 403 y no una lista
   * vacia: devolver cero resultados haria pensar en un problema de datos cuando
   * el problema es que se esta usando la llave equivocada.
   */
  clientMismatch: () =>
    new AppError(
      'CLIENT_MISMATCH',
      'Esa llave no pertenece al casillero por el que preguntas.',
      403,
    ),
  packageNotFound: () =>
    new AppError('PACKAGE_NOT_FOUND', 'No hay ningún paquete tuyo con ese tracking.', 404),
  /**
   * Se paso el limite de peticiones. La respuesta lleva ademas `Retry-After`, que
   * lo pone el propio middleware: el mensaje dice cuanto, la cabecera lo dice en
   * un formato que un cliente puede obedecer solo.
   */
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(
      'RATE_LIMITED',
      `Demasiadas peticiones. Vuelve a intentarlo en ${retryAfterSeconds} segundos.`,
      429,
    ),
};

/** Errores de la definicion de rutas (panel admin, permiso routes.manage). */
export const RouteErrors = {
  notFound: () => new AppError('DISTRICT_ROUTE_NOT_FOUND', 'El distrito no tiene una ruta asignada.', 404),
  districtNotFound: () => new AppError('DISTRICT_NOT_FOUND', 'Distrito no encontrado.', 404),
  /**
   * Quitar la ruta de un canton solo falla si el canton no la tenia puesta a
   * mano; que sus distritos queden sin ruta al hacerlo es lo esperado (dejan de
   * heredar), no un error.
   */
  cantonRouteNotFound: () =>
    new AppError('CANTON_ROUTE_NOT_FOUND', 'El cantón no tiene una ruta asignada.', 404),
  cantonNotFound: () => new AppError('CANTON_NOT_FOUND', 'Cantón no encontrado.', 404),
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
