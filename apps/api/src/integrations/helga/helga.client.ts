/**
 * Cliente HTTP saliente del proveedor Helga (docs/13 §3.1). Es una integracion
 * interna: nunca se expone al navegador. Todas las llamadas salen del backend,
 * cuya IP esta en la lista blanca del proveedor, con un `Origin` registrado.
 *
 * Operaciones: A (token, en `helga.auth`), B (consulta de estado), C (prealerta
 * v2), D (crear destinatario casillero) y E (paquetes disponibles).
 *
 * Rutas y shapes de B, D y E verificados EN VIVO contra la cuenta SJO008835
 * (2026-07-23): la IP del backend ya esta en la lista blanca. C (prealerta v2)
 * usa la ruta correcta `/api/v2/prealertas` pero le faltan campos obligatorios
 * que el alta todavia no captura (ver TODO en `createHelgaPrealert`).
 *
 * TRES MODOS (`helgaMode`, en `core/config`): `on` sale a la red, `simulated`
 * responde desde `helga.mock` sin salir del proceso, y `off` no invoca nada de
 * este archivo. La simulacion se sustituye en el TRANSPORTE, dentro de `request`:
 * todo lo demas de este modulo (armado del cuerpo, envoltura, errores, paginado)
 * corre igual en los dos modos, que es justamente lo que se quiere probar.
 */
import { Currency, roundMoney } from '@courier/shared';
import type { HelgaAccount } from '../../core/config';
import { config, helgaMode, helgaPrincipalAccount } from '../../core/config';
import { ProviderErrors } from '../../core/errors';
import { getAccessToken, invalidateToken } from './helga.auth';
import {
  HELGA_ACCOUNT_CLIENT_ID,
  HELGA_DEFAULT_TARIFF_POSITION,
  HELGA_FIXED_GEO,
  HELGA_FIXED_RECIPIENT,
  HELGA_ID_TYPE_CEDULA,
  helgaEmailFor,
  splitPersonName,
} from './helga.constants';
import type {
  HelgaAvailablePackage,
  HelgaCreatePrealertRequest,
  HelgaCreateRecipientRequest,
  HelgaEnvelope,
  HelgaPackageStatus,
  HelgaPaginator,
  HelgaPrealertResponse,
  HelgaRecipientResponse,
} from './helga.types';
import { normalizeEnvelope } from './helga.types';
import { mockHelgaRequest } from './helga.mock';

/**
 * True si el sistema debe hablar con el proveedor, de verdad o simulado. Es lo que
 * miran los servicios y el scheduler: para ellos la simulacion es una integracion
 * encendida, y esa es la gracia (el flujo completo se ejercita sin credenciales).
 * Quien necesite distinguir el modo usa `isHelgaSimulated`.
 */
export function isHelgaEnabled(): boolean {
  return helgaMode !== 'off';
}

/** True si las respuestas del proveedor las produce el simulador en proceso. */
export function isHelgaSimulated(): boolean {
  return helgaMode === 'simulated';
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
 *
 * `allowNotFound`: para la consulta de estado (op. B), un `404` no es un error de
 * infraestructura sino un caso de negocio esperado (el paquete todavia no existe
 * del lado de Helga: prealerta que aun no llega). Con la bandera puesta se
 * devuelve `undefined` en vez de lanzar, y el llamador lo interpreta como "sin
 * estado por ahora".
 *
 * `account`: CONTRA QUE CUENTA del proveedor se hace la llamada. Ausente = la
 * principal, que es el comportamiento de siempre. No es un detalle de transporte:
 * cada cuenta emite su propio token y VE SOLO SUS PAQUETES, asi que preguntar por
 * el paquete de un cliente consolidado con el token de la principal no da un error
 * de permisos sino un 404 silencioso, que se lee como "todavia no llego".
 */
async function request<T>(
  method: 'POST' | 'DELETE',
  path: string,
  body: unknown,
  opts: { allowNotFound?: boolean; account?: HelgaAccount } = {},
): Promise<T | undefined> {
  const account = opts.account;
  // El `app_id` de la cuenta manda sobre el del despliegue. Se resuelve fuera del
  // objeto de cabeceras a proposito: un spread condicional ahi dentro le quita a
  // TypeScript la forma de `HeadersInit`.
  const appId = account?.appId ?? config.HELGA_APP_ID;

  const send = async (token: string): Promise<Response> =>
    fetch(`${config.HELGA_BASE_URL}${path}`, {
      method,
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
        ...(appId ? { 'X-App-Id': appId } : {}),
      },
      // Algunas rutas (op. B) no llevan cuerpo: el criterio va en la URL.
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.HELGA_TIMEOUT_MS),
    });

  const startedAt = Date.now();
  // El codigo de casillero va en el log: con varias cuentas, un fallo sin decir
  // CUAL no se puede diagnosticar.
  const tag = `${isHelgaSimulated() ? '[helga:sim]' : '[helga]'}${account ? ` ${account.code}` : ''}`;
  let response: Response;
  try {
    if (isHelgaSimulated()) {
      // El simulador devuelve un `Response` real: de aqui hacia abajo no hay
      // ninguna diferencia con el proveedor. Tampoco pide token, porque en este
      // modo no hay credenciales que pedir.
      response = await mockHelgaRequest(method, path, body);
    } else {
      response = await send(await getAccessToken(account));
      if (response.status === 401) {
        invalidateToken(account);
        response = await send(await getAccessToken(account));
      }
    }
  } catch (err) {
    // Timeout o fallo de red. El detalle va al log, no al cliente.
    console.error(`${tag} ${method} ${path} falló tras ${Date.now() - startedAt}ms:`, err);
    throw ProviderErrors.unavailable();
  }

  const payload = (await response.json().catch(() => ({}))) as HelgaEnvelope<T>;
  const { data, message } = normalizeEnvelope(payload);
  console.info(`${tag} ${method} ${path} -> ${response.status} (${Date.now() - startedAt}ms)`);

  if (response.status === 404 && opts.allowNotFound) return undefined;
  if (!response.ok) throw providerError(response.status, message);
  return data;
}

/** Atajo para el caso normal: casi todas las rutas del proveedor son POST. */
function post<T>(
  path: string,
  body: unknown,
  opts: { allowNotFound?: boolean; account?: HelgaAccount } = {},
): Promise<T | undefined> {
  return request<T>('POST', path, body, opts);
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
  // El `cliente_id` es de la CUENTA bajo la que cuelga el destinatario, asi que
  // sale de la cuenta principal y no de una constante suelta. La constante queda
  // como valor de respaldo para la cuenta historica (SJO008835), que es la unica
  // cuyo id se resolvio en vivo.
  const clienteId = helgaPrincipalAccount?.clientId ?? HELGA_ACCOUNT_CLIENT_ID;

  if (clienteId === null || HELGA_FIXED_GEO.departamentoId === null || HELGA_FIXED_GEO.ciudadId === null) {
    // Config incompleta (ver TODOs de helga.constants). Fallamos claro en vez de
    // mandar una peticion que el proveedor rechazaria con un 422 opaco.
    console.error('[helga] falta cliente_id / departamento_id / ciudad_id de la dirección fija.');
    throw ProviderErrors.unavailable();
  }

  const name = splitPersonName(params.fullName);
  const body: HelgaCreateRecipientRequest = {
    cliente_id: clienteId,
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
 * Normaliza un importe (USD) que viaja al proveedor: descarta valores no finitos o
 * negativos (que Helga rechazaria) y redondea a 2 decimales en este unico borde de
 * salida (regla M4). El valor ya suele venir redondeado desde la persistencia; esto
 * es la red del limite con el proveedor. `null`/ausente -> 0, el default del negocio.
 */
function usdAmountFor(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return roundMoney(value, Currency.USD);
}

/**
 * Op. C — prealerta un paquete ante el proveedor. Es lo que autoriza al sistema a
 * empezar a preguntar por su estado: sin prealerta, el paquete no existe del lado
 * de Helga hasta que llega fisicamente a su bodega.
 *
 * La v2 exige `valor_comercial`, `valor_asegurado` y `posicion_arancelaria`; sin
 * cualquiera de los tres responde 422. Los defaults (0 / 0 / COURIER) reflejan la
 * practica real de HS Global: el valor asegurado casi siempre es 0 y el arancel
 * especifico no se conoce al prealertar. El valor comercial es el unico dato real
 * por paquete y llega desde el valor declarado del tramite.
 *
 * OJO con `posicion_arancelaria`: no basta con mandarla, tiene que ser un
 * `codigo_arancelario` que exista en el catalogo del proveedor (si no, 422 "No se
 * encontro la posicion arancelaria") y tiene que ser CADENA (el id numerico da
 * "must be a string"). Por eso lo que no venga validado cae al default en vez de
 * viajar tal cual.
 *
 * Verificado en vivo el 2026-07-26: responde `201` con `data.Id`.
 *
 * Devuelve el id de la prealerta si el proveedor lo da; no es imprescindible,
 * porque el cruce posterior se hace por tracking.
 */
export async function createHelgaPrealert(params: {
  helgaClientId: string;
  tracking: string;
  description: string;
  store?: string | null;
  /** Valor comercial declarado (USD). Ausente/null -> 0. */
  commercialValue?: number | null;
  /** Valor asegurado (USD). Ausente/null -> 0. */
  insuredValue?: number | null;
  /** Posicion arancelaria. Se omite cuando esta vacia. */
  tariffPosition?: string | null;
  /** Retener en bodega del proveedor. Ausente/null -> false. */
  retain?: boolean | null;
}): Promise<string | null> {
  const body: HelgaCreatePrealertRequest = {
    tracking: params.tracking,
    contenido: params.description,
    // El proveedor exige `tienda`; cuando no se conoce usa este mismo centinela.
    tienda: params.store?.trim() || 'POR DEFINIR',
    destinatario_id: params.helgaClientId,
    valor_comercial: usdAmountFor(params.commercialValue),
    valor_asegurado: usdAmountFor(params.insuredValue),
    retener: params.retain ?? false,
    // Obligatoria. Sin arancel conocido va la generica de paqueteria (COURIER):
    // omitirla haria fallar TODA prealerta del portal, donde el cliente no captura
    // este campo.
    posicion_arancelaria: params.tariffPosition?.trim() || HELGA_DEFAULT_TARIFF_POSITION,
  };

  const data = await post<HelgaPrealertResponse>('/api/v2/prealertas', body);
  const raw = data?.Id ?? data?.id ?? data?.prealerta_id;
  return raw === undefined || raw === null ? null : String(raw);
}

/**
 * Op. F — elimina una prealerta del proveedor.
 *
 * NO esta en el manual: se descubrio probando (2026-07-26). La ruta correcta es
 * `/api/casillero/prealertas/{id}`; bajo `/api/v2/prealertas/{id}` da 404 aunque
 * ese sea el prefijo con el que se CREA.
 *
 * Solo acepta el `Id` que devolvio la op. C, y por eso lo persistimos: su API no
 * ofrece forma de encontrar una prealerta por tracking, asi que sin ese id la
 * prealerta es imborrable.
 *
 * Devuelve `true` si el proveedor la elimino y `false` si ya no existia (404).
 * Ese caso NO es un error: significa que el estado deseado ya se cumple.
 */
export async function deleteHelgaPrealert(prealertId: string): Promise<boolean> {
  const data = await request<boolean>(
    'DELETE',
    `/api/casillero/prealertas/${encodeURIComponent(prealertId)}`,
    undefined,
    { allowNotFound: true },
  );
  return data !== undefined;
}

/**
 * Op. B — estado ACTUAL de UN paquete, buscado por HAWB, tracking de tienda o
 * guia transportadora. El criterio va en la URL, sin cuerpo.
 *
 * Devuelve `null` cuando el proveedor responde `404`: el paquete no existe o no
 * es de la cuenta. En la practica es una prealerta que todavia no llega a bodega
 * —Helga aun no la reconoce como paquete y por tanto no tiene estado. No es un
 * error: la sincronizacion lo trata como "sin estado por ahora".
 */
export async function fetchHelgaPackageState(
  search: string,
  account?: HelgaAccount,
): Promise<HelgaPackageStatus | null> {
  const data = await post<HelgaPackageStatus>(
    `/api/casillero/consulta-estado/${encodeURIComponent(search)}`,
    undefined,
    { allowNotFound: true, ...(account ? { account } : {}) },
  );
  return data ?? null;
}

/**
 * Op. E — paquetes disponibles para despacho de TODA la cuenta (paginado). No es
 * por destinatario: cada fila trae su `destinatario_id`. Es la via para descubrir
 * compras que el cliente no declaro; el manual pide poder darlas de alta igual.
 * Recorre las paginas hasta agotar el paginador de Laravel.
 *
 * "Toda la cuenta" es literal y es la razon de que el descubrimiento recorra las
 * cuentas una por una: el listado de una cuenta EXCLUSIVA trae los paquetes de
 * sus sub-casilleros y de nadie mas, que es exactamente lo que hay que atribuir
 * a su cliente consolidado.
 */
export async function fetchHelgaAvailablePackages(params: {
  pageSize?: number;
  search?: string;
  /** Cuenta cuyo listado se pide. Ausente = la principal (comportamiento de siempre). */
  account?: HelgaAccount;
} = {}): Promise<HelgaAvailablePackage[]> {
  const pageSize = params.pageSize ?? 100;
  const all: HelgaAvailablePackage[] = [];
  let page = 1;
  let lastPage = 1;

  do {
    const body = {
      pageSize,
      ...(params.search ? { str_busqueda: params.search } : {}),
    };
    const data = await post<HelgaPaginator<HelgaAvailablePackage>>(
      `/api/casillero/despachos/preliquidaciones/paqsdisponibles?page=${page}`,
      body,
      params.account ? { account: params.account } : {},
    );
    if (Array.isArray(data?.data)) all.push(...data.data);
    lastPage = data?.last_page ?? page;
    page += 1;
  } while (page <= lastPage);

  return all;
}
