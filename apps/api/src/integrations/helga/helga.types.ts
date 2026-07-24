/**
 * Tipos del contrato del proveedor Helga (docs/13 §2): token (op. A), consulta de
 * estado (B), prealerta v2 (C), crear destinatario casillero (D) y paquetes
 * disponibles (E).
 *
 * Los shapes de B y E se verificaron EN VIVO contra la cuenta SJO008835
 * (2026-07-23): las rutas y nombres de campo de abajo son los reales, no los del
 * PDF. Ojo con dos trampas confirmadas: (1) B y E devuelven el MISMO paquete con
 * nombres distintos (B: `Estado_Envio`/`Seguimiento`, mayusculas; E: `estado`/
 * `trackings`, minusculas); (2) los pesos llegan a veces como cadena ("1.38").
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
 * Cuerpo de `POST /api/v2/prealertas` (op. C, prealerta v2). La ruta v2 identifica
 * la cuenta por el token, asi que NO lleva `cliente_id` (a diferencia de op. D).
 *
 * Asocia un tracking a un destinatario ANTES de que el paquete entre a bodega,
 * que es justo lo que permite que el proveedor empiece a reportar su estado.
 *
 * TODO(13): el manual marca ademas como OBLIGATORIOS `valor_comercial`,
 * `valor_asegurado`, `posicion_arancelaria` y `retener`, que el alta todavia no
 * captura. Sin ellos la v2 responde 422 con la lista de faltantes; se cablearan
 * cuando el flujo de prealerta recoja el valor declarado y la posicion
 * arancelaria. NO se inventan aqui: mandar una posicion arancelaria o un valor
 * equivocados crearia una prealerta erronea, peor que fallar de forma visible.
 */
export interface HelgaCreatePrealertRequest {
  /** Numero de guia del transportista (UPS, Fedex...). Unico del lado de Helga. */
  tracking: string;
  /** Descripcion del contenido (nuestro `description`). */
  contenido: string;
  /** Tienda donde se compro; obligatoria. Default "POR DEFINIR" si no se conoce. */
  tienda: string;
  /** Id del destinatario en Helga (nuestro `clients.helga_client_id`). */
  destinatario_id: string;
}

/**
 * Respuesta de la op. C (v2): `{ success, message, data: { Id, Tracking, ... } }`.
 * `normalizeEnvelope` deja `data` = ese objeto; nos basta el id de la prealerta.
 */
export interface HelgaPrealertResponse {
  Id?: string | number;
  id?: string | number;
  prealerta_id?: string | number;
  Tracking?: string;
}

/** Un evento del historial de tracking (op. B, `datos.Seguimiento[]`). */
export interface HelgaTrackingEvent {
  /** Estado en el vocabulario del proveedor; se homologa con `mapProviderState`. */
  estado?: string;
  lugar?: string;
  fecha?: string;
  observacion?: string;
  visible?: boolean;
}

/**
 * Respuesta de la op. B (`POST /api/casillero/consulta-estado/{busqueda}`): el
 * estado ACTUAL de UN paquete, buscado por HAWB, tracking de tienda o guia. El
 * proveedor devuelve un unico objeto en `datos` (no una lista). `404` si el
 * paquete no existe o no es de la cuenta —tipicamente una prealerta que aun no
 * llega a bodega, que Helga todavia no reconoce como paquete.
 *
 * Los nombres van en mayusculas tal como los emite el proveedor.
 */
export interface HelgaPackageStatus {
  /** HAWB del paquete (la guia aerea). */
  Sello?: string;
  /** Tracking de tienda (UPS/Fedex...): la clave con la que cruzamos `shipments`. */
  tracking?: string;
  /** Ultimo estado. `"NO TIENE ESTADO"` cuando el paquete aun no tiene tracking. */
  Estado_Envio?: string;
  contenido?: string;
  /** Pesos: pueden venir como numero o como cadena ("1.38"). Se normalizan al leer. */
  Peso_kg?: number | string;
  Peso_lb?: number | string;
  Peso_volumen?: number | string;
  Largo_cm?: number;
  Ancho_cm?: number;
  Alto_cm?: number;
  valor_declarado?: number;
  valor_manifestado?: number;
  /** Historial de tracking para el timeline. */
  Seguimiento?: HelgaTrackingEvent[];
  /** Duenos del paquete; `codigo_casillero` identifica el sub-casillero. */
  cliente?: Array<{ codigo_casillero?: string }>;
}

/** Un evento de guia dentro de un paquete disponible (op. E, `trackings[]`). */
export interface HelgaGuiaEvent {
  estado_guia_id?: number;
  punto_control_id?: number;
  fecha_hora?: string;
  observacion?: string;
  estado_de_guia?: { id?: number; descripcion?: string };
}

/**
 * Un paquete disponible para despacho (op. E). Es toda la cuenta consolidada, no
 * un destinatario: cada fila trae su `destinatario_id`. Nombres en minusculas.
 */
export interface HelgaAvailablePackage {
  id?: number;
  hawb?: string;
  /** Tracking de tienda: la clave con la que cruzamos contra `shipments`. */
  tracking?: string;
  /** Estado en el vocabulario del proveedor; se homologa con `mapProviderState`. */
  estado?: string;
  contenido?: string;
  peso?: number;
  peso_kg?: number | string;
  peso_lb?: number | string;
  valor_declarado?: number;
  valor_asegurado?: number;
  fecha_recibido?: string;
  destinatario_id?: number;
  tienda?: string;
  trackings?: HelgaGuiaEvent[];
}

/**
 * Paginador estilo Laravel: la op. E envuelve las filas en `datos.data`, con
 * `current_page`/`last_page` para recorrer las paginas.
 */
export interface HelgaPaginator<T> {
  current_page?: number;
  last_page?: number;
  data?: T[];
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
