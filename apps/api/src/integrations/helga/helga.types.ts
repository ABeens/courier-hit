/**
 * Tipos del contrato del proveedor Helga (docs/13 §2): token (op. A), consulta de
 * estado (B), prealerta v2 (C), crear destinatario casillero (D) y paquetes
 * disponibles (E).
 *
 * TODO(13): los campos de B, C y E salen de los PDF del manual del proveedor y
 * estan pendientes de contrastar contra respuestas reales — la integracion no se
 * ha podido ejercitar porque la IP del backend aun no esta en su lista blanca.
 * Los campos opcionales lo son por prudencia: preferimos leer de menos a que un
 * campo ausente rompa la sincronizacion.
 */

/** Respuesta de `POST /oauth/token` (op. A). */
export interface HelgaTokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

/**
 * Cuerpo de `POST /api/casillero/destinatarios` (op. D).
 *
 * Identidad real del cliente (nombre, apellidos, cedula); contacto y ubicacion
 * siempre los fijos de HS Global (docs/13 §3.6).
 */
export interface HelgaCreateRecipientRequest {
  cliente_id: number;
  primer_nombre: string;
  /** Helga exige que esten presentes aunque vayan vacios. */
  segundo_nombre: string;
  primer_apellido: string;
  segundo_apellido: string;
  pais_codigo: string;
  departamento_id: number;
  ciudad_id: number;
  telefono_celular: string;
  direccion: string;
  /** Correo inventado, nunca el real del cliente (docs/13 §3.6.b). */
  email: string;
  /** No estan en la lista de obligatorios, pero el proveedor los acepta y los
   *  usa (junto con el nombre) para su regla de unicidad. Verificado en vivo. */
  tipo_de_identificacion_id?: number;
  numero_de_identificacion?: string;
}

/**
 * Respuesta de la op. D. Ademas del `id`, el proveedor asigna un `sub_casillero`
 * propio de cada destinatario (p. ej. `SJO008835S033`): es la direccion con la
 * que el cliente recibe en Miami, asi que hay que conservarla.
 */
export interface HelgaRecipientResponse {
  id?: string | number;
  Id?: string | number;
  destinatario_id?: string | number;
  sub_casillero?: string;
  nombre_completo?: string;
}

/**
 * Cuerpo de `POST /api/casillero/prealertas` (op. C, prealerta v2).
 *
 * Asocia un tracking a un destinatario ANTES de que el paquete entre a bodega,
 * que es justo lo que permite que el proveedor empiece a reportar su estado.
 */
export interface HelgaCreatePrealertRequest {
  cliente_id: number;
  /** Id del destinatario en Helga (nuestro `clients.helga_client_id`). */
  destinatario_id: string;
  /** Numero de guia del transportista (UPS, Fedex...). */
  tracking: string;
  descripcion: string;
  /** Tienda donde se compro; el proveedor la usa como referencia. */
  tienda?: string;
  /** Valor declarado de la compra, si se conoce. */
  valor?: number;
}

/** Respuesta de la op. C: el id de la prealerta creada del lado del proveedor. */
export interface HelgaPrealertResponse {
  id?: string | number;
  prealerta_id?: string | number;
}

/**
 * Paquete tal como lo describe el proveedor en las ops. B y E. Todos los campos
 * son opcionales porque el manual no garantiza cuales vienen en cada ruta.
 */
export interface HelgaPackage {
  id?: string | number;
  /** Guia del transportista: es la clave con la que cruzamos contra `shipments`. */
  tracking?: string;
  guia?: string;
  /** Estado en el vocabulario del proveedor; se homologa con `mapProviderState`. */
  estado?: string;
  /** Peso en libras o kilos segun la ruta; se normaliza al leerlo. */
  peso?: number;
  peso_lb?: number;
  valor?: number;
  descripcion?: string;
  fecha?: string;
}

/**
 * Envoltura de respuesta de Helga. El proveedor es inconsistente: unas rutas
 * devuelven `{ datos, msg, errores }` y otras `{ success, message, data, errors }`.
 * `normalizeEnvelope` unifica ambas formas.
 */
export interface HelgaEnvelope<T> {
  datos?: T;
  data?: T;
  msg?: string;
  message?: string;
  errores?: unknown;
  errors?: unknown;
  success?: boolean;
}

export interface NormalizedEnvelope<T> {
  data: T | undefined;
  message: string | undefined;
  errors: unknown;
}

export function normalizeEnvelope<T>(body: HelgaEnvelope<T>): NormalizedEnvelope<T> {
  return {
    data: body.datos ?? body.data,
    message: body.msg ?? body.message,
    errors: body.errores ?? body.errors,
  };
}
