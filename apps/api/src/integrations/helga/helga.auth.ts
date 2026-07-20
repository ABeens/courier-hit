/**
 * Token OAuth del proveedor Helga (docs/13 §2.A y §3.2).
 *
 * El token dura ~1 año, pero no se asume: se cachea con su vencimiento y se pide
 * de nuevo de forma perezosa. Las peticiones concurrentes comparten la misma
 * promesa para no emitir dos tokens a la vez.
 *
 * TODO(13): persistir el token y el `refresh_token` (tabla `provider_credentials`)
 * y usar el grant `refresh_token`. Hoy la cache es en memoria: al reiniciar la
 * API se pide un token nuevo con el grant `password`, que es idempotente. El
 * refresh rota el token anterior, asi que sin persistencia no se puede usar.
 */
import { config } from '../../core/config';
import { ProviderErrors } from '../../core/errors';
import type { HelgaTokenResponse } from './helga.types';

interface CachedToken {
  accessToken: string;
  /** Instante (epoch ms) a partir del cual se considera vencido. */
  expiresAt: number;
}

let cached: CachedToken | null = null;
let inFlight: Promise<string> | null = null;

/** Margen para no usar un token que vence mientras la peticion viaja. */
const EXPIRY_SKEW_MS = 60_000;

async function requestToken(): Promise<string> {
  const response = await fetch(`${config.HELGA_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      client_id: config.HELGA_CLIENT_ID,
      client_secret: config.HELGA_CLIENT_SECRET,
      username: config.HELGA_USERNAME,
      password: config.HELGA_PASSWORD,
      scope: '',
    }),
    signal: AbortSignal.timeout(config.HELGA_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Nunca logueamos el cuerpo: lleva credenciales.
    console.error(`[helga] /oauth/token respondió ${response.status}`);
    throw ProviderErrors.unauthenticated();
  }

  const body = (await response.json()) as HelgaTokenResponse;
  if (!body.access_token) throw ProviderErrors.unauthenticated();

  cached = {
    accessToken: body.access_token,
    expiresAt: Date.now() + Math.max(0, body.expires_in * 1000 - EXPIRY_SKEW_MS),
  };
  return body.access_token;
}

/** Token vigente, de la cache o recien pedido. */
export async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;
  // Serializa: varias llamadas concurrentes esperan la misma emision.
  inFlight ??= requestToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Invalida la cache para forzar una emision nueva (tras un 401 del proveedor). */
export function invalidateToken(): void {
  cached = null;
}
