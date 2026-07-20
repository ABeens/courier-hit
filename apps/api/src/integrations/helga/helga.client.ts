/**
 * Cliente HTTP saliente del proveedor Helga (docs/13 §3.1). Es una integracion
 * interna: nunca se expone al navegador. Todas las llamadas salen del backend,
 * cuya IP esta en la lista blanca del proveedor, con un `Origin` registrado.
 *
 * Implementado hoy: op. D (crear destinatario casillero), que es lo que necesita
 * la creacion de casillero.
 * TODO(13): ops. B (consulta-estado), C (prealertas v2) y E (paqs. disponibles)
 * cuando exista el modulo `packages`.
 */
import { config } from '../../core/config';
import { ProviderErrors } from '../../core/errors';
import { getAccessToken, invalidateToken } from './helga.auth';
import {
  HELGA_ACCOUNT_CLIENT_ID,
  HELGA_FIXED_GEO,
  HELGA_FIXED_RECIPIENT,
  helgaEmailFor,
} from './helga.constants';
import type { HelgaCreateRecipientRequest, HelgaEnvelope } from './helga.types';
import { normalizeEnvelope } from './helga.types';

/** True si la integracion esta encendida y configurada. */
export function isHelgaEnabled(): boolean {
  return config.HELGA_ENABLED;
}

/** Traduce el status del proveedor a nuestro contrato de errores (docs/13 §3.5). */
function providerError(status: number, message: string | undefined): Error {
  if (status === 403) return ProviderErrors.forbidden();
  if (status === 401) return ProviderErrors.unauthenticated();
  if (status === 400 || status === 422) return ProviderErrors.validation(message);
  return ProviderErrors.unavailable();
}

/**
 * POST autenticado contra Helga. Ante un 401 refresca el token y reintenta UNA
 * vez; cualquier otro fallo se traduce y se propaga.
 */
async function post<T>(path: string, body: unknown): Promise<T | undefined> {
  const send = async (token: string): Promise<Response> =>
    fetch(`${config.HELGA_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        // Sin un Origin registrado, Helga responde 403 "Acceso denegado".
        ...(config.HELGA_ORIGIN ? { Origin: config.HELGA_ORIGIN } : {}),
        // TODO(13): el manual del proveedor NO documenta cómo viaja el app_id.
        // Solo lo menciona al describir el 403 ("el app_id no es el correcto o
        // el Origin no está registrado"), y su bloque de cabeceras únicamente
        // lista Accept, Authorization y Origin. `X-App-Id` es una SUPOSICIÓN:
        // hay que confirmar con Helga si es cabecera (y con qué nombre) o si va
        // en el cuerpo de la petición.
        ...(config.HELGA_APP_ID ? { 'X-App-Id': config.HELGA_APP_ID } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.HELGA_TIMEOUT_MS),
    });

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await send(await getAccessToken());
    if (response.status === 401) {
      invalidateToken();
      response = await send(await getAccessToken());
    }
  } catch (err) {
    // Timeout o fallo de red. El detalle va al log, no al cliente.
    console.error(`[helga] POST ${path} falló tras ${Date.now() - startedAt}ms:`, err);
    throw ProviderErrors.unavailable();
  }

  const payload = (await response.json().catch(() => ({}))) as HelgaEnvelope<T>;
  const { data, message } = normalizeEnvelope(payload);
  console.info(`[helga] POST ${path} -> ${response.status} (${Date.now() - startedAt}ms)`);

  if (!response.ok) throw providerError(response.status, message);
  return data;
}

/** Lo que nos importa de la respuesta de la op. D: el id del destinatario. */
function extractRecipientId(data: unknown): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    // Helga no es consistente con la capitalizacion de la clave del id.
    const raw = record['id'] ?? record['Id'] ?? record['destinatario_id'];
    if (typeof raw === 'string' && raw.length > 0) return raw;
    if (typeof raw === 'number') return String(raw);
  }
  // Sin id no hay enlace posible con nuestro cliente: es un fallo del proveedor.
  throw ProviderErrors.validation('no devolvió el id del destinatario.');
}

/**
 * Op. D — registra el casillero de un cliente nuestro en Helga y devuelve el id
 * del proveedor, que guardamos en `clients.helga_client_id`.
 *
 * Todos los datos que viajan son los fijos de consolidacion de HS Global; lo
 * unico derivado del cliente es el correo, y es inventado (docs/13 §3.6). Ni la
 * direccion, ni el telefono, ni el correo reales salen de nuestra BD.
 */
export async function createHelgaRecipient(realEmail: string): Promise<string> {
  if (HELGA_ACCOUNT_CLIENT_ID === null || HELGA_FIXED_GEO.departamentoId === null || HELGA_FIXED_GEO.ciudadId === null) {
    // Config incompleta (ver TODOs de helga.constants). Fallamos claro en vez de
    // mandar una peticion que el proveedor rechazaria con un 422 opaco.
    console.error('[helga] falta cliente_id / departamento_id / ciudad_id de la dirección fija.');
    throw ProviderErrors.unavailable();
  }

  const body: HelgaCreateRecipientRequest = {
    cliente_id: HELGA_ACCOUNT_CLIENT_ID,
    primer_nombre: HELGA_FIXED_RECIPIENT.firstName,
    segundo_nombre: '',
    primer_apellido: HELGA_FIXED_RECIPIENT.lastName,
    segundo_apellido: '',
    pais_codigo: HELGA_FIXED_RECIPIENT.countryCode,
    departamento_id: HELGA_FIXED_GEO.departamentoId,
    ciudad_id: HELGA_FIXED_GEO.ciudadId,
    telefono_celular: HELGA_FIXED_RECIPIENT.mobilePhone,
    direccion: HELGA_FIXED_RECIPIENT.address,
    email: helgaEmailFor(realEmail),
  };

  return extractRecipientId(await post('/api/casillero/destinatarios', body));
}
