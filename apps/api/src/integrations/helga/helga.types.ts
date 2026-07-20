/**
 * Tipos del contrato del proveedor Helga (docs/13 §2). Solo lo que consumimos
 * hoy: token (op. A) y crear destinatario casillero (op. D).
 *
 * TODO(13): añadir los tipos de las operaciones B (consulta-estado), C
 * (prealertas v2) y E (paquetes disponibles) cuando exista el modulo `packages`.
 */

/** Respuesta de `POST /oauth/token` (op. A). */
export interface HelgaTokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

/** Cuerpo de `POST /api/casillero/destinatarios` (op. D). */
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
