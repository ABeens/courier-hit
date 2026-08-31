/**
 * Llaves de API: emision, rotacion, revocacion y comprobacion (docs/16 §5).
 *
 * Tres decisiones viven aqui y conviene leerlas antes de tocar nada:
 *
 * 1. EL SECRETO NO SE GUARDA. De la llave solo queda `token_hash`. Se enseña una
 *    vez, al crearla, y despues no existe ni para nosotros: si el cliente la
 *    pierde, se rota. No hay "reenviarme mi llave" porque no hay nada que
 *    reenviar, y esa es exactamente la propiedad que se quiere.
 *
 * 2. EL HASH ES SHA-256, NO ARGON2. Al reves que las contraseñas, y no por
 *    descuido. Una contraseña la elige una persona y tiene poca entropia, asi
 *    que hay que encarecer cada intento. Una llave son 160 bits aleatorios
 *    generados por nosotros: no hay diccionario que la adivine, ni siquiera con
 *    un hash instantaneo. Y hay una razon activa para que sea rapido: esto corre
 *    en CADA peticion de la API publica, y argon2 (decenas de milisegundos de
 *    CPU por comprobacion, a proposito) convertiria la autenticacion en el
 *    cuello de botella y, peor, en un vector de denegacion de servicio: bastaria
 *    con mandar llaves falsas para quemar la CPU del servidor.
 *
 * 3. LA COMPARACION ES DE TIEMPO CONSTANTE. Un `===` sobre el hash filtra, por
 *    lo que tarda en fallar, cuantos caracteres iniciales acerto quien prueba.
 *    Con la busqueda por `token_id` el ataque es rebuscado, pero `timingSafeEqual`
 *    no cuesta nada y elimina la pregunta.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  API_KEY_ALPHABET,
  API_KEY_ID_LENGTH,
  API_KEY_LAST_FOUR,
  API_KEY_PREFIX,
  API_KEY_SECRET_LENGTH,
  ApiKeyRevokeReason,
  UserStatus,
  formatApiKeyPreview,
  parseApiKey,
} from '@courier/shared';
import type {
  ApiKeyCreatedDto,
  ApiKeyDto,
  ApiKeyEnvironment,
  ApiKeyListDto,
  CreateApiKeyInput,
  RotateApiKeyInput,
  Session,
} from '@courier/shared';
import { config, isProd } from '../../core/config';
import { ApiKeyErrors, ShipmentErrors } from '../../core/errors';
import { apiKeysRepo, type ApiKeyAuthRow } from './api-keys.repo';
import type { ApiKeyRow } from './api-keys.schema';

/**
 * Entorno de las llaves que emite ESTE servidor, y el unico que acepta. Va atado
 * a `NODE_ENV` y no a una variable propia: la razon de ser del segmento es que
 * una llave de pruebas no pueda operar en produccion, y eso se pierde en cuanto
 * se puede configurar por separado.
 */
export const apiKeyEnvironment: ApiKeyEnvironment = isProd ? 'live' : 'test';

/**
 * Cada cuanto, como mucho, se reescribe `last_used_at`. Ver `apiKeysRepo.touch`:
 * el dato util es "esta llave se sigue usando", no el segundo exacto.
 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Cadena aleatoria del alfabeto de las llaves, uniforme (32 divide a 256). */
function randomToken(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += API_KEY_ALPHABET[byte & 31];
  return out;
}

/** SHA-256 en hexadecimal del token completo. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Comparacion de hashes en tiempo constante. Longitudes distintas => false. */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Fila -> DTO. Nunca incluye el token: no existe (solo su hash). */
function toDto(row: ApiKeyRow): ApiKeyDto {
  const environment = row.environment as ApiKeyEnvironment;
  return {
    id: row.id,
    name: row.name,
    environment,
    preview: formatApiKeyPreview(environment, row.tokenId, row.lastFour),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedReason: (row.revokedReason as ApiKeyRevokeReason | null) ?? null,
    rotatedFromId: row.rotatedFromId,
    active: row.revokedAt === null,
  };
}

/** El casillero de la sesion, o el fallo de datos que significa no tenerlo. */
function clientIdOf(session: Session): string {
  if (!session.clientId) throw ShipmentErrors.missingClientProfile();
  return session.clientId;
}

/**
 * Resultado de comprobar una llave que llego en una peticion. Se devuelve en vez
 * de lanzarse porque quien llama (el middleware) tiene que poder distinguir los
 * motivos y traducirlos a errores distintos.
 */
export type ApiKeyCheck =
  | { ok: true; keyId: string; clientId: string; clientCode: string }
  | { ok: false; reason: 'invalid' | 'revoked' | 'inactive' };

export const apiKeysService = {
  /** Las llaves del casillero de la sesion, con el techo y cuantas van. */
  async list(session: Session): Promise<ApiKeyListDto> {
    const clientId = clientIdOf(session);
    const rows = await apiKeysRepo.listByClient(clientId);
    const items = rows.map(toDto);
    return {
      items,
      maxActive: config.API_KEYS_MAX_ACTIVE,
      activeCount: items.filter((k) => k.active).length,
    };
  },

  /**
   * Emite una llave nueva para el casillero de la sesion.
   *
   * El token completo se devuelve AQUI y en ningun otro sitio: no se registra en
   * el log, no se manda por correo y no se puede volver a consultar.
   */
  async create(session: Session, input: CreateApiKeyInput): Promise<ApiKeyCreatedDto> {
    const clientId = clientIdOf(session);

    const active = await apiKeysRepo.countActive(clientId);
    if (active >= config.API_KEYS_MAX_ACTIVE) {
      throw ApiKeyErrors.tooMany(config.API_KEYS_MAX_ACTIVE);
    }

    return this.issue(clientId, session.userId, input.name, null);
  },

  /**
   * Rota una llave: nace la sustituta y la vieja queda revocada como 'rotated'.
   *
   * El orden importa. Primero se emite la nueva y despues se revoca la vieja: al
   * reves, un fallo entre las dos operaciones dejaria al cliente sin ninguna
   * credencial viva y con la integracion caida. Asi, el peor desenlace es que
   * queden dos llaves buenas un momento, que es un problema que se arregla solo
   * con el boton de revocar.
   *
   * Por eso mismo la rotacion NO mira el tope de llaves activas: rotar la ultima
   * llave permitida es justo el caso que hay que dejar pasar.
   */
  async rotate(session: Session, id: string, input: RotateApiKeyInput): Promise<ApiKeyCreatedDto> {
    const clientId = clientIdOf(session);
    const current = await apiKeysRepo.findById(id);
    // 404 y no 403 cuando la llave es de otro casillero: la API no confirma la
    // existencia de credenciales ajenas.
    if (!current || current.clientId !== clientId) throw ApiKeyErrors.notFound();
    if (current.revokedAt !== null) throw ApiKeyErrors.alreadyRevoked();

    const created = await this.issue(clientId, session.userId, input.name ?? current.name, current.id);
    await apiKeysRepo.revoke(current.id, ApiKeyRevokeReason.Rotated);
    return created;
  },

  /** Revoca una llave a mano. Irreversible: no hay "deshacer", hay "crear otra". */
  async revoke(session: Session, id: string): Promise<ApiKeyDto> {
    const clientId = clientIdOf(session);
    const current = await apiKeysRepo.findById(id);
    if (!current || current.clientId !== clientId) throw ApiKeyErrors.notFound();

    const revoked = await apiKeysRepo.revoke(current.id, ApiKeyRevokeReason.Manual);
    if (!revoked) throw ApiKeyErrors.alreadyRevoked();
    return toDto(revoked);
  },

  /**
   * Genera y guarda una llave. Compartido por el alta y la rotacion.
   *
   * El reintento por colision del identificador publico es teatro estadistico
   * (80 bits), pero cuesta tres lineas y evita que una casualidad se convierta en
   * un 500 con un error de indice unico que nadie sabria leer.
   */
  async issue(
    clientId: string,
    userId: string,
    name: string,
    rotatedFromId: string | null,
  ): Promise<ApiKeyCreatedDto> {
    let tokenId = randomToken(API_KEY_ID_LENGTH);
    for (let attempt = 0; attempt < 3 && (await apiKeysRepo.tokenIdExists(tokenId)); attempt += 1) {
      tokenId = randomToken(API_KEY_ID_LENGTH);
    }

    const secret = randomToken(API_KEY_SECRET_LENGTH);
    const token = `${API_KEY_PREFIX}_${apiKeyEnvironment}_${tokenId}_${secret}`;

    const row = await apiKeysRepo.insert({
      clientId,
      name,
      environment: apiKeyEnvironment,
      tokenId,
      tokenHash: hashToken(token),
      lastFour: secret.slice(-API_KEY_LAST_FOUR),
      createdByUserId: userId,
      rotatedFromId,
    });

    return { ...toDto(row), token };
  },

  /**
   * Comprueba la llave que llego en una peticion de la API publica.
   *
   * Las cuatro barreras, en orden de coste: forma -> existencia -> secreto ->
   * estado de la cuenta. La ultima se consulta EN VIVO y no se cachea: dar de
   * baja a un cliente tiene que cortarle el acceso en la siguiente peticion, no
   * cuando expire algo.
   */
  async verify(raw: string): Promise<ApiKeyCheck> {
    const parsed = parseApiKey(raw);
    if (!parsed) return { ok: false, reason: 'invalid' };
    // Una llave de otro entorno es tan invalida como una inventada, y se responde
    // igual: decir "esta llave es de pruebas" confirmaria que existe.
    if (parsed.environment !== apiKeyEnvironment) return { ok: false, reason: 'invalid' };

    const row: ApiKeyAuthRow | null = await apiKeysRepo.findForAuth(parsed.tokenId);
    if (!row) return { ok: false, reason: 'invalid' };
    if (!hashesMatch(row.tokenHash, hashToken(raw.trim()))) return { ok: false, reason: 'invalid' };
    if (row.revokedAt !== null) return { ok: false, reason: 'revoked' };
    if (row.userStatus !== UserStatus.Activo) return { ok: false, reason: 'inactive' };

    // Anotar el uso no puede hacer fallar la peticion: es telemetria, no parte de
    // la autenticacion. Va sin `await` y con el error tragado a proposito.
    const cutoff = new Date(Date.now() - TOUCH_INTERVAL_MS);
    if (!row.lastUsedAt || row.lastUsedAt < cutoff) {
      void apiKeysRepo.touch(row.id, cutoff).catch((err) => {
        console.error('[api-keys] no se pudo anotar el uso de la llave:', err);
      });
    }

    return { ok: true, keyId: row.id, clientId: row.clientId, clientCode: row.clientCode };
  },
};
