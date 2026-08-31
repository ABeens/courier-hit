/**
 * Token OAuth del proveedor Helga (docs/13 §2.A y §3.2).
 *
 * El manual dice que el token dura ~1 año, pero el ambiente real devuelve
 * `expires_in: 3600` (1 hora, medido el 2026-07-20): no se asume nada, se cachea
 * con el vencimiento que venga y se pide de nuevo de forma perezosa. Las
 * peticiones concurrentes comparten la misma promesa para no emitir dos tokens
 * a la vez.
 *
 * TODO(13): persistir el token y el `refresh_token` (tabla `provider_credentials`)
 * y usar el grant `refresh_token`. Hoy la cache es en memoria: al reiniciar la
 * API se pide un token nuevo con el grant `password`, que es idempotente. El
 * refresh rota el token anterior, asi que sin persistencia no se puede usar.
 */
import { type HelgaAccount, config, helgaPrincipalAccount } from '../../core/config';
import { ProviderErrors } from '../../core/errors';
import type { HelgaTokenResponse } from './helga.types';

interface CachedToken {
  accessToken: string;
  /** Instante (epoch ms) a partir del cual se considera vencido. */
  expiresAt: number;
}

/**
 * Cache POR CUENTA, no global: cada casillero tiene su propio login y su propio
 * token, y usar el de otra cuenta no da un error de permisos evidente sino datos
 * del casillero equivocado, que es mucho peor. La clave es el codigo de casillero.
 */
const cached = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<string>>();

/** Margen para no usar un token que vence mientras la peticion viaja. */
const EXPIRY_SKEW_MS = 60_000;

/** La cuenta pedida, o la principal. Falla claro si no hay ninguna configurada. */
function resolveAccount(account?: HelgaAccount): HelgaAccount {
  const resolved = account ?? helgaPrincipalAccount;
  if (!resolved) {
    console.error('[helga] no hay ninguna cuenta configurada (HELGA_ACCOUNTS vacío).');
    throw ProviderErrors.unauthenticated();
  }
  return resolved;
}

async function requestToken(account: HelgaAccount): Promise<string> {
  const response = await fetch(`${config.HELGA_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      client_id: config.HELGA_CLIENT_ID,
      client_secret: config.HELGA_CLIENT_SECRET,
      username: account.username,
      password: account.password,
      scope: '',
    }),
    signal: AbortSignal.timeout(config.HELGA_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Nunca logueamos el cuerpo: lleva credenciales. El codigo de casillero si,
    // porque con varias cuentas hace falta saber CUAL fallo.
    console.error(`[helga] /oauth/token de ${account.code} respondió ${response.status}`);
    throw ProviderErrors.unauthenticated();
  }

  const body = (await response.json()) as HelgaTokenResponse;
  if (!body.access_token) throw ProviderErrors.unauthenticated();

  cached.set(account.code, {
    accessToken: body.access_token,
    expiresAt: Date.now() + Math.max(0, body.expires_in * 1000 - EXPIRY_SKEW_MS),
  });
  return body.access_token;
}

/** Token vigente de una cuenta (la principal por defecto), de la cache o recien pedido. */
export async function getAccessToken(account?: HelgaAccount): Promise<string> {
  const target = resolveAccount(account);

  const hit = cached.get(target.code);
  if (hit && hit.expiresAt > Date.now()) return hit.accessToken;

  // Serializa POR CUENTA: varias llamadas concurrentes de la misma cuenta esperan
  // la misma emision, y dos cuentas distintas no se bloquean entre si.
  const pending = inFlight.get(target.code);
  if (pending) return pending;

  const emission = requestToken(target).finally(() => {
    inFlight.delete(target.code);
  });
  inFlight.set(target.code, emission);
  return emission;
}

/** Invalida el token de una cuenta (la principal por defecto), tras un 401. */
export function invalidateToken(account?: HelgaAccount): void {
  cached.delete(resolveAccount(account).code);
}
