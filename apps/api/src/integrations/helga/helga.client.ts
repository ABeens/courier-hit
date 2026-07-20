/**
 * Cliente HTTP saliente del proveedor Helga (docs/13 §3.1). Es una integracion
 * interna: nunca se expone al navegador. Todas las llamadas salen del backend,
 * cuya IP esta en la lista blanca del proveedor, con un `Origin` registrado.
 *
 * Operaciones: A (token, en `helga.auth`), B (consulta de estado), C (prealerta
 * v2), D (crear destinatario casillero) y E (paquetes disponibles).
 *
 * TODO(13): B, C y E estan escritas contra los PDF del manual pero NO se han
 * podido ejercitar: la IP del backend todavia no esta en la lista blanca del
 * proveedor. Al habilitarla hay que verificar las rutas y los nombres de los
 * campos contra respuestas reales. Mientras `HELGA_ENABLED` sea false, nada de
 * esto se invoca y el sistema opera solo con sus propios estados.
 */
import { config } from '../../core/config';
import { ProviderErrors } from '../../core/errors';
import { getAccessToken, invalidateToken } from './helga.auth';
import {
  HELGA_ACCOUNT_CLIENT_ID,
  HELGA_FIXED_GEO,
  HELGA_FIXED_RECIPIENT,
  HELGA_ID_TYPE_CEDULA,
  helgaEmailFor,
  splitPersonName,
} from './helga.constants';
import type {
  HelgaCreatePrealertRequest,
  HelgaCreateRecipientRequest,
  HelgaEnvelope,
  HelgaPackage,
  HelgaPrealertResponse,
  HelgaRecipientResponse,
} from './helga.types';
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
        // El app_id NO hace falta: verificado en vivo (2026-07-20) que las ops.
        // B-E responden sin enviarlo. Lo que el proveedor valida es el Origin.
        // Se sigue mandando si esta configurado, por si alguna ruta lo exige;
        // el nombre de la cabecera sigue siendo una suposicion (el manual no lo
        // documenta).
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
function extractRecipientId(data: HelgaRecipientResponse | undefined): string {
  // Helga no es consistente con la capitalizacion de la clave del id.
  const raw = data?.id ?? data?.Id ?? data?.destinatario_id;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'number') return String(raw);
  // Sin id no hay enlace posible con nuestro cliente: es un fallo del proveedor.
  throw ProviderErrors.validation('no devolvió el id del destinatario.');
}

/** Resultado de la op. D: el id del destinatario y su casillero en Miami. */
export interface HelgaRecipient {
  id: string;
  /** `sub_casillero` del proveedor: la direccion con la que el cliente recibe. */
  subLocker: string | null;
}

/**
 * Op. D — registra el casillero de un cliente nuestro en Helga.
 *
 * Viaja la identidad REAL del cliente (nombre, apellidos, cedula) porque el
 * paquete se entrega contra documento y porque Helga exige nombre unico dentro
 * de la cuenta. NO viaja nada de su contacto ni de su ubicacion: el telefono y
 * la direccion son los fijos de consolidacion de HS Global y el correo es
 * inventado (docs/13 §3.6).
 */
export async function createHelgaRecipient(params: {
  fullName: string;
  idNumber: string;
  realEmail: string;
}): Promise<HelgaRecipient> {
  if (HELGA_ACCOUNT_CLIENT_ID === null || HELGA_FIXED_GEO.departamentoId === null || HELGA_FIXED_GEO.ciudadId === null) {
    // Config incompleta (ver TODOs de helga.constants). Fallamos claro en vez de
    // mandar una peticion que el proveedor rechazaria con un 422 opaco.
    console.error('[helga] falta cliente_id / departamento_id / ciudad_id de la dirección fija.');
    throw ProviderErrors.unavailable();
  }

  const name = splitPersonName(params.fullName);
  const body: HelgaCreateRecipientRequest = {
    cliente_id: HELGA_ACCOUNT_CLIENT_ID,
    primer_nombre: name.firstName,
    segundo_nombre: name.secondName,
    primer_apellido: name.lastName,
    segundo_apellido: name.secondLastName,
    tipo_de_identificacion_id: HELGA_ID_TYPE_CEDULA,
    numero_de_identificacion: params.idNumber,
    pais_codigo: HELGA_FIXED_RECIPIENT.countryCode,
    departamento_id: HELGA_FIXED_GEO.departamentoId,
    ciudad_id: HELGA_FIXED_GEO.ciudadId,
    telefono_celular: HELGA_FIXED_RECIPIENT.mobilePhone,
    direccion: HELGA_FIXED_RECIPIENT.address,
    email: helgaEmailFor(params.realEmail),
  };

  const data = await post<HelgaRecipientResponse>('/api/casillero/destinatarios', body);
  return { id: extractRecipientId(data), subLocker: data?.sub_casillero ?? null };
}

/**
 * Op. C — prealerta un paquete ante el proveedor. Es lo que autoriza al sistema a
 * empezar a preguntar por su estado: sin prealerta, el paquete no existe del lado
 * de Helga hasta que llega fisicamente a su bodega.
 *
 * Devuelve el id de la prealerta si el proveedor lo da; no es imprescindible,
 * porque el cruce posterior se hace por tracking.
 */
export async function createHelgaPrealert(params: {
  helgaClientId: string;
  tracking: string;
  description: string;
  store?: string | null;
}): Promise<string | null> {
  if (HELGA_ACCOUNT_CLIENT_ID === null) {
    console.error('[helga] falta cliente_id de la cuenta de HS Global.');
    throw ProviderErrors.unavailable();
  }

  const body: HelgaCreatePrealertRequest = {
    cliente_id: HELGA_ACCOUNT_CLIENT_ID,
    destinatario_id: params.helgaClientId,
    tracking: params.tracking,
    descripcion: params.description,
    ...(params.store ? { tienda: params.store } : {}),
  };

  const data = await post<HelgaPrealertResponse>('/api/casillero/prealertas', body);
  const raw = data?.id ?? data?.prealerta_id;
  return raw === undefined || raw === null ? null : String(raw);
}

/**
 * Op. B — estado actual de los paquetes de un destinatario.
 *
 * El proveedor solo expone los paquetes DEL CLIENTE consultado (su API esta
 * pensada para el casillero de un cliente, no para todo el sistema), asi que la
 * sincronizacion recorre casillero por casillero en vez de pedir "todo lo nuevo".
 */
export async function fetchHelgaPackageStates(helgaClientId: string): Promise<HelgaPackage[]> {
  const data = await post<HelgaPackage[]>('/api/casillero/consulta-estado', {
    cliente_id: HELGA_ACCOUNT_CLIENT_ID,
    destinatario_id: helgaClientId,
  });
  return Array.isArray(data) ? data : [];
}

/**
 * Op. E — paquetes disponibles en bodega del destinatario, incluidos los que
 * NUNCA se prealertaron. Es la via para descubrir compras que el cliente no
 * declaro: el manual pide poder darlas de alta igual.
 */
export async function fetchHelgaAvailablePackages(helgaClientId: string): Promise<HelgaPackage[]> {
  const data = await post<HelgaPackage[]>('/api/casillero/paquetes-disponibles', {
    cliente_id: HELGA_ACCOUNT_CLIENT_ID,
    destinatario_id: helgaClientId,
  });
  return Array.isArray(data) ? data : [];
}
