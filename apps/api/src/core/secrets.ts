/**
 * Cifrado de secretos de terceros guardados en NUESTRA base de datos.
 *
 * QUE GUARDA Y POR QUE NO ES UN HASH. Las credenciales de una cuenta del
 * proveedor (contrasena y `client_secret` de Helga) hay que poder VOLVER A
 * LEERLAS: el robot las usa cada vez que pide un token. Eso las separa de las
 * contrasenas de nuestros usuarios, que se guardan con argon2id y no se
 * recuperan nunca (`auth.service`), y de las llaves de API, de las que solo
 * queda un SHA-256 (`api-keys.service`). Un hash aqui seria inservible.
 *
 * COMO. AES-256-GCM con una clave del entorno (`PROVIDER_SECRETS_KEY`) y un IV
 * aleatorio por cada cifrado. GCM y no CBC porque autentica: un texto cifrado
 * alterado en la base falla al descifrar en vez de devolver basura que acabaria
 * viajando al proveedor como si fuera una contrasena.
 *
 * FORMATO EN LA COLUMNA. `v1.<iv>.<tag>.<ciphertext>`, las tres partes en
 * base64url. La version va delante para poder rotar el algoritmo mas adelante
 * sin adivinar como se escribio cada fila.
 *
 * LO QUE ESTO NO ES. La clave vive en el entorno del servidor, asi que quien
 * tenga la base Y el entorno tiene los secretos. Lo que compra es que un volcado
 * de la base (una copia de seguridad, un `select` de mas) no sea una lista de
 * contrasenas del proveedor en claro.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from './config';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
/** GCM se define sobre un IV de 96 bits; es el tamano recomendado y el mas rapido. */
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * La clave, resuelta UNA vez y perezosamente.
 *
 * Perezosa a proposito: sin cuentas exclusivas dadas de alta, este archivo no se
 * usa, y exigir la variable al arrancar dejaria sin API a un despliegue que no
 * necesita la funcion. El fallo aparece cuando alguien intenta guardar o leer una
 * credencial, que es el momento en el que de verdad hace falta.
 */
let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = config.PROVIDER_SECRETS_KEY;
  if (!raw) {
    throw new Error(
      'PROVIDER_SECRETS_KEY no está configurada: sin ella no se pueden guardar ni leer ' +
        'las credenciales de las cuentas del operador de Miami. Genera 32 bytes en base64 ' +
        '(por ejemplo `openssl rand -base64 32`) y ponla en el entorno de la API.',
    );
  }

  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `PROVIDER_SECRETS_KEY debe ser de ${KEY_BYTES} bytes en base64 (llegaron ${buf.length}).`,
    );
  }

  cachedKey = buf;
  return buf;
}

/** True si el despliegue puede cifrar. Lo consulta el arranque para avisar, no para fallar. */
export function secretsKeyConfigured(): boolean {
  return Boolean(config.PROVIDER_SECRETS_KEY);
}

/** Cifra un secreto para guardarlo en una columna de texto. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Descifra lo que devolvio `encryptSecret`.
 *
 * Lanza si la fila esta corrupta, si se cifro con otra clave o si alguien la
 * altero. No se degrada a "devolver algo": un secreto equivocado que viaja al
 * proveedor es un 401 opaco por cuenta, y encima repetido en cada corrida del
 * robot; es mucho mejor que reviente aqui, con nombre y apellido.
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('El secreto guardado no tiene el formato esperado.');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];

  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
