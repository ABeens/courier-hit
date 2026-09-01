/**
 * Llave de API de un cliente: la credencial con la que un sistema de terceros
 * habla con la API publica de HS Global (docs/16 §2).
 *
 * Aqui vive SOLO la forma de la llave, no como se guarda ni como se comprueba:
 * eso es de la API (`modules/api-keys`). Esta en el dominio compartido porque el
 * portal tiene que saber leer una llave para mostrarla y la documentacion
 * publica tiene que describir su formato sin copiarlo a mano.
 *
 * Forma:
 *
 *     hsk_live_muestramuestramu_muestramuestramuestramuestramues
 *     ^^^ ^^^^ ^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *      |   |          |                        |
 *      |   |          |                        secreto (160 bits)
 *      |   |          identificador publico (80 bits)
 *      |   entorno: `live` en produccion, `test` en el resto
 *      prefijo fijo del producto
 *
 * Las cuatro partes cumplen un proposito distinto:
 *
 *   - El PREFIJO hace la llave reconocible de un vistazo en un log o en un
 *     repositorio, que es lo que permite a los buscadores de secretos (y a
 *     nosotros) detectar una llave filtrada.
 *   - El ENTORNO evita el peor accidente de integracion: apuntar a produccion
 *     creyendo estar en pruebas. Se ve en la propia credencial.
 *   - El IDENTIFICADOR se guarda EN CLARO y es por donde la API encuentra la
 *     fila. Sin el habria que comparar el hash contra todas las llaves vivas.
 *   - El SECRETO no se guarda nunca: de el solo queda un hash (ver
 *     `api-keys.service.ts`). Se muestra UNA vez, al crearla.
 */

/** Prefijo fijo de toda llave del producto. `hs key`. */
export const API_KEY_PREFIX = 'hsk';

/**
 * Entorno al que pertenece la llave. Va DENTRO de la credencial, no al lado:
 * una llave copiada a otro sitio se sigue explicando sola.
 */
export const API_KEY_ENVIRONMENTS = ['live', 'test'] as const;
export type ApiKeyEnvironment = (typeof API_KEY_ENVIRONMENTS)[number];

/**
 * Alfabeto de las dos partes aleatorias: base32 SIN los caracteres que se
 * confunden al dictar o al leer (`l`, `o`, `0`, `1`). Una llave se copia y se
 * pega, pero tambien se lee en voz alta por telefono cuando algo falla.
 */
export const API_KEY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Largo del identificador publico: 16 x 5 bits = 80 bits. */
export const API_KEY_ID_LENGTH = 16;

/**
 * Largo del secreto: 32 x 5 bits = 160 bits de entropia. Es lo que permite
 * guardarlo como SHA-256 y no como argon2: un secreto de 160 bits aleatorios no
 * se rompe por fuerza bruta ni con un hash rapido, y el hash rapido es
 * obligatorio aqui porque se comprueba en CADA peticion (ver §5 de docs/16).
 */
export const API_KEY_SECRET_LENGTH = 32;

/**
 * Cuantos caracteres del secreto se guardan en claro para que el cliente
 * reconozca su llave en la pantalla. Cuatro no acercan a adivinar el resto
 * (quedarian 140 bits) y bastan para distinguir dos llaves de la misma cuenta.
 */
export const API_KEY_LAST_FOUR = 4;

/**
 * Cuantas llaves ACTIVAS puede tener un casillero a la vez. Existe por la
 * rotacion: hacen falta al menos dos vivas para cambiar la credencial de un
 * sistema en produccion sin cortarle el servicio. Mas de un puñado ya no es
 * rotar, es haber perdido la cuenta de quien tiene acceso.
 */
export const MAX_ACTIVE_API_KEYS = 5;

/** Formato completo de una llave, para validar lo que llega en la cabecera. */
export const API_KEY_PATTERN = new RegExp(
  `^${API_KEY_PREFIX}_(${API_KEY_ENVIRONMENTS.join('|')})_` +
    `([${API_KEY_ALPHABET}]{${API_KEY_ID_LENGTH}})_([${API_KEY_ALPHABET}]{${API_KEY_SECRET_LENGTH}})$`,
);

/** Las tres piezas de una llave ya separadas. */
export interface ParsedApiKey {
  environment: ApiKeyEnvironment;
  /** Parte publica: es la que la API busca en la tabla. */
  tokenId: string;
  secret: string;
}

/**
 * Separa una llave en sus piezas, o `null` si no tiene la forma esperada.
 *
 * Que devuelva `null` en vez de lanzar es deliberado: quien la llama esta
 * mirando una cabecera que viene de fuera, y una cabecera mal formada es un 401
 * normal y corriente, no una excepcion.
 */
export function parseApiKey(raw: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(raw.trim());
  if (!match) return null;
  return {
    environment: match[1] as ApiKeyEnvironment,
    tokenId: match[2] as string,
    secret: match[3] as string,
  };
}

/**
 * Como se ve una llave en pantalla despues de crearla: lo publico entero y los
 * ultimos cuatro del secreto. El resto NO existe en ningun sitio.
 *
 *     hsk_live_muestramuestramu...mues
 */
export function formatApiKeyPreview(
  environment: ApiKeyEnvironment,
  tokenId: string,
  lastFour: string,
): string {
  return `${API_KEY_PREFIX}_${environment}_${tokenId}...${lastFour}`;
}

/**
 * Por que se dejo de poder usar una llave. Se guarda para poder responderle al
 * cliente "esa la reemplazaste tu al rotar" en vez de un 401 mudo.
 */
export enum ApiKeyRevokeReason {
  /** El cliente la revoco a mano desde el portal. */
  Manual = 'manual',
  /** Se rotó: la reemplaza una llave nueva. */
  Rotated = 'rotated',
}

export const API_KEY_REVOKE_REASON_VALUES = Object.values(ApiKeyRevokeReason) as [
  ApiKeyRevokeReason,
  ...ApiKeyRevokeReason[],
];
