/**
 * Proveedor Helga SIMULADO (docs/13). Existe para poder recorrer el flujo entero
 * sin credenciales, sin red y sin crear destinatarios reales en la cuenta del
 * proveedor.
 *
 * DONDE SE ENCHUFA: en `helga.client.request()`, sustituyendo el `fetch`. No es un
 * stub de los servicios: devuelve un `Response` con la MISMA envoltura que Helga,
 * asi que todo lo que hay aguas abajo (normalizeEnvelope, extractRecipientId, el
 * mapeo de errores 403/422/404, el paginador de la op. E, `advanceTowards`) corre
 * exactamente igual que en produccion. Los robots no consultan otra ruta ni otra
 * URL: no hay red de por medio, solo una rama de funcion.
 *
 * COMO AVANZA UN PAQUETE: no hay proceso que lo empuje ni campo `estado` que
 * alguien escriba. El mundo guarda el instante en que arranco el reloj
 * (`startedAt`, sellado al prealertar) y el estado se CALCULA al consultarlo:
 *
 *     paso = floor((ahora - startedAt) / HELGA_SIMULATED_STEP)
 *     paso 0        -> 404 (aun no llega a bodega: prealerta sin recibir)
 *     paso 1..8     -> TIMELINE[paso - 1]
 *     paso > 8      -> se queda en el ultimo
 *
 * Con `HELGA_SIMULATED_STEP` corto el paquete salta varios estados entre corridas del
 * robot, que es el caso realista (Helga tambien lo hace) y el que ejercita el
 * avance paso a paso de `provider-sync`.
 *
 * PERSISTENCIA: el mundo se vuelca a `./.helga-mock.json` (ignorado por git) para
 * sobrevivir a los reinicios de `tsx watch`. Borrar el archivo, o llamar a
 * `POST /api/dev/helga/reset`, deja el mundo limpio.
 *
 * NUNCA EN PRODUCCION: el arranque falla si `HELGA_MODE=simulated` con
 * `NODE_ENV=production` (ver `core/config.ts`).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { helgaSimulatedStepMs } from '../../core/config';
import { HELGA_DEFAULT_TARIFF_POSITION } from './helga.constants';

/** Archivo donde vive el mundo simulado, relativo al cwd de la API (apps/api). */
const WORLD_FILE = './.helga-mock.json';

/**
 * Linea de tiempo del tramo del proveedor. Los estados son los REALES de su
 * catalogo (`HELGA_STATE_MAP` en @courier/shared): recorre las cuatro paradas
 * nuestras, dos estados del proveedor por cada una, para que el avance de un paso
 * de la simulacion no siempre mueva el tramite (asi tambien se prueba el caso
 * "el proveedor reporto algo nuevo pero el tramite no cambia").
 */
const TIMELINE: ReadonlyArray<{ estado: string; lugar: string }> = [
  { estado: 'DIGITADO', lugar: 'MIAMI' },
  { estado: 'RECIBIDO', lugar: 'MIAMI' },
  { estado: 'CONSOLIDADA', lugar: 'MIAMI' },
  { estado: 'MANIFESTADA', lugar: 'MIAMI' },
  { estado: 'ENTREGADA A TRANSPORTADORA', lugar: 'MIAMI' },
  { estado: 'LLEGA A AEROPUERTO DESTINO', lugar: 'SAN JOSE' },
  { estado: 'EN PLANILLA DE ENTREGA', lugar: 'SAN JOSE' },
  { estado: 'ENTREGADA A DESTINATARIO', lugar: 'SAN JOSE' },
];

/** Estado con el que la op. E lista un paquete disponible (ventana de captura). */
const DISCOVERY_STATE = 'DIGITADO';

/** Destinatario creado por la op. D. */
export interface MockRecipient {
  /** Ids en el rango 9.000.000 para que se distingan a simple vista de los reales. */
  id: string;
  /** null en los recuperados: no sabemos su sub-casillero (ver `ensureRecipient`). */
  subLocker: string | null;
  name: string;
  email: string;
  idNumber: string;
  createdAt: string;
}

/** Paquete del mundo simulado. No guarda estado: guarda el reloj. */
export interface MockPackage {
  tracking: string;
  hawb: string;
  recipientId: string;
  content: string;
  store: string;
  commercialValue: number;
  insuredValue: number;
  tariffPosition: string;
  /** Id de la prealerta (op. C), o null si se inyecto directo (flujo 2). */
  prealertId: string | null;
  /** Instante (epoch ms) del que sale el estado. Ver la formula de arriba. */
  startedAt: number;
  /** Estado fijado a mano desde las rutas dev; ignora el reloj. */
  pinnedState: string | null;
  /** Sub-casillero que reporta el proveedor. null = el del destinatario. */
  reportedLocker: string | null;
}

/** Fallo programado para las proximas llamadas. */
export interface MockFailure {
  /** 0 = no responde (timeout de red). Cualquier otro = codigo HTTP. */
  status: number;
  /** Se consume al primer uso. */
  once: boolean;
  /** Solo para llamadas sobre este tracking. null = cualquier llamada. */
  tracking: string | null;
  message: string | null;
}

interface MockWorld {
  recipients: MockRecipient[];
  packages: MockPackage[];
  failures: MockFailure[];
  nextRecipient: number;
  nextPrealert: number;
}

function emptyWorld(): MockWorld {
  return { recipients: [], packages: [], failures: [], nextRecipient: 1, nextPrealert: 1 };
}

let world: MockWorld | null = null;

/** Carga perezosa: el archivo solo se toca cuando de verdad se simula algo. */
function getWorld(): MockWorld {
  if (world) return world;
  if (existsSync(WORLD_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(WORLD_FILE, 'utf8')) as Partial<MockWorld>;
      world = {
        ...emptyWorld(),
        ...parsed,
        recipients: parsed.recipients ?? [],
        packages: parsed.packages ?? [],
        failures: parsed.failures ?? [],
      };
      return world;
    } catch (err) {
      // Un archivo corrupto no debe impedir trabajar: se empieza de cero.
      console.warn(`[helga:sim] ${WORLD_FILE} ilegible, se reinicia el mundo:`, err);
    }
  }
  world = emptyWorld();
  return world;
}

function saveWorld(): void {
  try {
    writeFileSync(WORLD_FILE, `${JSON.stringify(world, null, 2)}\n`, 'utf8');
  } catch (err) {
    // Perder la persistencia degrada la simulacion pero no la rompe: el mundo
    // sigue en memoria hasta el proximo reinicio.
    console.warn(`[helga:sim] no se pudo escribir ${WORLD_FILE}:`, err);
  }
}

// --- Datos derivados del tracking -------------------------------------------
// Pesos y medidas tienen que ser ESTABLES entre consultas: si cambiaran, el flete
// bailaria en cada corrida del robot. Se derivan del hash del tracking en vez de
// sortearse, asi el mismo tracking siempre pesa lo mismo sin guardar nada.

function hashSlice(text: string, salt: string): number {
  const hex = createHash('sha256').update(`${salt}:${text}`).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16);
}

function derived(tracking: string, salt: string, min: number, max: number, decimals: number): number {
  const span = max - min;
  const value = min + (hashSlice(tracking, salt) / 0xffffffff) * span;
  return Number(value.toFixed(decimals));
}

interface MockMeasures {
  kg: number;
  lb: number;
  volumetric: number;
  length: number;
  width: number;
  height: number;
}

function measuresFor(tracking: string): MockMeasures {
  const kg = derived(tracking, 'kg', 0.3, 14, 2);
  const length = derived(tracking, 'len', 12, 60, 0);
  const width = derived(tracking, 'wid', 10, 45, 0);
  const height = derived(tracking, 'hei', 5, 40, 0);
  return {
    kg,
    lb: Number((kg * 2.20462).toFixed(2)),
    // Divisor 5000: el habitual de courier aereo.
    volumetric: Number(((length * width * height) / 5000).toFixed(2)),
    length,
    width,
    height,
  };
}

// --- El reloj ----------------------------------------------------------------

/** Paso en el que va el paquete: 0 = todavia no llega a bodega. */
export function currentStep(pkg: MockPackage): number {
  const elapsed = Date.now() - pkg.startedAt;
  if (elapsed < 0) return 0;
  return Math.floor(elapsed / helgaSimulatedStepMs);
}

/**
 * Estado que el proveedor reporta AHORA, o null si el paquete todavia no existe
 * para el (la op. B responde 404 en ese caso).
 */
export function currentState(pkg: MockPackage): string | null {
  if (pkg.pinnedState) return pkg.pinnedState;
  const step = currentStep(pkg);
  if (step < 1) return null;
  const entry = TIMELINE[Math.min(step, TIMELINE.length) - 1];
  return entry ? entry.estado : null;
}

/** Historial acumulado hasta el paso actual, con la fecha en que "ocurrio" cada uno. */
function trackingEvents(pkg: MockPackage): Array<{
  estado: string;
  lugar: string;
  fecha: string;
  observacion: string;
  visible: boolean;
}> {
  const step = Math.min(currentStep(pkg), TIMELINE.length);
  const events = TIMELINE.slice(0, step).map((entry, i) => ({
    estado: entry.estado,
    lugar: entry.lugar,
    // Fechas en UTC (regla del repo): la presentacion las convierte.
    fecha: new Date(pkg.startedAt + (i + 1) * helgaSimulatedStepMs).toISOString(),
    observacion: 'Movimiento simulado.',
    visible: true,
  }));

  // Un estado fijado a mano es lo ultimo que paso, aunque el reloj diga otra cosa.
  if (pkg.pinnedState) {
    events.push({
      estado: pkg.pinnedState,
      lugar: 'SIMULADO',
      fecha: new Date().toISOString(),
      observacion: 'Estado forzado desde /api/dev/helga/advance.',
      visible: true,
    });
  }
  return events;
}

// --- Fallos programados ------------------------------------------------------

/**
 * Devuelve el fallo aplicable a esta llamada y lo consume si era de un solo uso.
 * Los especificos de un tracking ganan sobre los globales aunque se hayan armado
 * despues: asi se puede tener un fallo general armado y ademas hacer que UN
 * paquete falle de otra forma, sin depender del orden en que se programaron.
 */
function takeFailure(tracking: string | null): MockFailure | undefined {
  const w = getWorld();
  const specific = w.failures.findIndex((f) => f.tracking !== null && f.tracking === tracking);
  const index = specific >= 0 ? specific : w.failures.findIndex((f) => f.tracking === null);
  if (index < 0) return undefined;
  const failure = w.failures[index];
  if (!failure) return undefined;
  if (failure.once) {
    w.failures.splice(index, 1);
    saveWorld();
  }
  return failure;
}

// --- Respuestas --------------------------------------------------------------

/** Envoltura `{ datos, msg }`: la que usan las rutas `/api/casillero/*`. */
function legacyEnvelope(data: unknown, message: string): Response {
  return json(200, { datos: data, msg: message, errores: null });
}

/** Envoltura `{ success, message, data }`: la que usa `/api/v2/*`. */
function v2Envelope(data: unknown, message: string, status = 201): Response {
  return json(status, { success: true, message, data, errors: null });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, message: string): Response {
  return json(status, { success: false, msg: message, message, errores: [message], datos: null });
}

// --- Operaciones del proveedor -----------------------------------------------

/** Op. D: crear destinatario de casillero. */
function opCreateRecipient(body: Record<string, unknown>): Response {
  const w = getWorld();
  const email = String(body.email ?? '');
  const name = [body.primer_nombre, body.segundo_nombre, body.primer_apellido, body.segundo_apellido]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(' ');

  // Helga valida que el correo no exista. Reintentar con el mismo cliente produce
  // el mismo correo derivado, asi que devolvemos el destinatario ya creado en vez
  // de duplicarlo: es lo que hace la reconciliacion cuando reintenta.
  const existing = w.recipients.find((r) => r.email === email);
  if (existing) {
    return legacyEnvelope(
      { id: existing.id, sub_casillero: existing.subLocker, nombre_completo: existing.name },
      'El destinatario ya existe.',
    );
  }

  const seq = w.nextRecipient;
  w.nextRecipient += 1;
  const recipient: MockRecipient = {
    // Rango 9.000.000: un id simulado no se confunde con uno real del proveedor.
    id: String(9_000_000 + seq),
    subLocker: `SJO008835S9${String(seq).padStart(2, '0')}`,
    name,
    email,
    idNumber: String(body.numero_de_identificacion ?? ''),
    createdAt: new Date().toISOString(),
  };
  w.recipients.push(recipient);
  saveWorld();

  console.info(`[helga:sim] destinatario ${recipient.id} (${recipient.subLocker}) para ${name}.`);
  return legacyEnvelope(
    { id: recipient.id, sub_casillero: recipient.subLocker, nombre_completo: recipient.name },
    'Destinatario creado.',
  );
}

/**
 * Destinatario del mundo simulado, recuperandolo si hace falta.
 *
 * Nuestra BD guarda el `helgaClientId` para siempre, pero el mundo simulado se
 * puede vaciar (`/reset`, o borrando el archivo). Tras un reinicio del mundo,
 * clientes ya enlazados quedarian apuntando a destinatarios que "no existen" y
 * TODAS sus prealertas fallarian con un 422 confuso, por una desincronizacion del
 * simulador y no por un fallo de nuestro codigo. Asi que un id desconocido se da
 * de alta al vuelo en vez de rechazarse.
 *
 * El recuperado nace SIN sub-casillero a proposito: no lo sabemos, e inventar uno
 * haria saltar el control de casillero que no coincide (`checkLockerMatch`) con un
 * falso positivo. Sin ese dato, la op. B no informa casillero y el control se
 * omite, que es exactamente lo correcto.
 *
 * Para probar de verdad el rechazo del proveedor esta `POST /api/dev/helga/fail`
 * con status 422.
 */
function ensureRecipient(id: string): MockRecipient {
  const w = getWorld();
  const existing = w.recipients.find((r) => r.id === id);
  if (existing) return existing;

  const recovered: MockRecipient = {
    id,
    subLocker: null,
    name: 'DESTINATARIO RECUPERADO',
    email: '',
    idNumber: '',
    createdAt: new Date().toISOString(),
  };
  w.recipients.push(recovered);
  saveWorld();
  console.warn(
    `[helga:sim] el destinatario ${id} no estaba en el mundo simulado (¿se reinició?); ` +
      'se recupera sin sub-casillero.',
  );
  return recovered;
}

/** Op. C: prealertar un paquete. Arranca el reloj de ese tracking. */
function opCreatePrealert(body: Record<string, unknown>): Response {
  const w = getWorld();
  const tracking = String(body.tracking ?? '').trim();
  if (!tracking) return errorResponse(422, 'El campo tracking es obligatorio.');

  // El tracking es unico del lado del proveedor: prealertar dos veces el mismo da
  // 422, igual que en vivo.
  if (w.packages.some((p) => p.tracking === tracking)) {
    return errorResponse(422, `El tracking ${tracking} ya está prealertado.`);
  }

  const recipientId = String(body.destinatario_id ?? '');
  if (!recipientId) return errorResponse(422, 'El campo destinatario_id es obligatorio.');
  ensureRecipient(recipientId);

  const seq = w.nextPrealert;
  w.nextPrealert += 1;
  const pkg: MockPackage = {
    tracking,
    hawb: `SIM${String(9_000_000 + seq)}`,
    recipientId,
    content: String(body.contenido ?? '').trim() || 'SIN DESCRIPCION',
    store: String(body.tienda ?? '').trim() || 'POR DEFINIR',
    commercialValue: Number(body.valor_comercial ?? 0),
    insuredValue: Number(body.valor_asegurado ?? 0),
    tariffPosition: String(body.posicion_arancelaria ?? HELGA_DEFAULT_TARIFF_POSITION),
    prealertId: `MOCK-${seq}`,
    startedAt: Date.now(),
    pinnedState: null,
    reportedLocker: null,
  };
  w.packages.push(pkg);
  saveWorld();

  console.info(`[helga:sim] prealerta ${pkg.prealertId} para ${tracking}; el reloj arranca ahora.`);
  return v2Envelope({ Id: pkg.prealertId, Tracking: tracking }, 'Prealerta creada.');
}

/** Op. F: eliminar una prealerta por su id. */
function opDeletePrealert(prealertId: string): Response {
  const w = getWorld();
  const index = w.packages.findIndex((p) => p.prealertId === prealertId);
  // 404 no es un error: significa que el estado deseado ya se cumple.
  if (index < 0) return errorResponse(404, 'La prealerta no existe.');
  w.packages.splice(index, 1);
  saveWorld();
  console.info(`[helga:sim] prealerta ${prealertId} eliminada.`);
  return legacyEnvelope(true, 'Prealerta eliminada.');
}

/** Op. B: estado actual de UN paquete, buscado por tracking o HAWB. */
function opPackageState(search: string): Response {
  const w = getWorld();
  const needle = search.trim().toUpperCase();
  const pkg = w.packages.find(
    (p) => p.tracking.toUpperCase() === needle || p.hawb.toUpperCase() === needle,
  );
  if (!pkg) return errorResponse(404, 'No se encontró el paquete.');

  const estado = currentState(pkg);
  // Prealertado pero aun sin llegar a bodega: para Helga todavia no es un paquete.
  if (!estado) return errorResponse(404, 'No se encontró el paquete.');

  const m = measuresFor(pkg.tracking);
  const recipient = w.recipients.find((r) => r.id === pkg.recipientId);
  const locker = pkg.reportedLocker ?? recipient?.subLocker ?? null;

  return legacyEnvelope(
    {
      Sello: pkg.hawb,
      tracking: pkg.tracking,
      Estado_Envio: estado,
      contenido: pkg.content,
      // Helga a veces manda el peso como cadena; se emite asi a proposito para
      // ejercitar la normalizacion de `toNumber`.
      Peso_kg: String(m.kg),
      Peso_lb: m.lb,
      Peso_volumen: m.volumetric,
      Largo_cm: m.length,
      Ancho_cm: m.width,
      Alto_cm: m.height,
      valor_declarado: pkg.commercialValue,
      valor_manifestado: pkg.commercialValue,
      Seguimiento: trackingEvents(pkg),
      cliente: locker ? [{ codigo_casillero: locker }] : [],
    },
    'Consulta exitosa.',
  );
}

/**
 * Op. E: paquetes disponibles para despacho de toda la cuenta, paginado.
 *
 * Solo lista los que estan en DIGITADO, igual que en vivo: en cuanto el reloj los
 * mueve al paso siguiente salen del listado y el descubrimiento ya no los ve. Esa
 * ventana de captura es justo lo que hay que poder probar (docs/13 §3.3).
 */
function opAvailablePackages(page: number, body: Record<string, unknown>): Response {
  const w = getWorld();
  const pageSize = Math.max(1, Number(body.pageSize ?? 100));
  const search = String(body.str_busqueda ?? '').trim().toUpperCase();

  const rows = w.packages
    .filter((p) => currentState(p) === DISCOVERY_STATE)
    .filter((p) => !search || p.tracking.toUpperCase().includes(search));

  const lastPage = Math.max(1, Math.ceil(rows.length / pageSize));
  const slice = rows.slice((page - 1) * pageSize, page * pageSize);

  return legacyEnvelope(
    {
      current_page: page,
      last_page: lastPage,
      data: slice.map((p, i) => {
        const m = measuresFor(p.tracking);
        return {
          id: 900_000 + (page - 1) * pageSize + i + 1,
          hawb: p.hawb,
          tracking: p.tracking,
          estado: DISCOVERY_STATE,
          contenido: p.content,
          peso: m.kg,
          peso_kg: String(m.kg),
          peso_lb: m.lb,
          volumen_peso: m.volumetric,
          alto: m.height,
          ancho: m.width,
          largo: m.length,
          valor_declarado: p.commercialValue,
          valor_asegurado: p.insuredValue,
          fecha_recibido: new Date(p.startedAt).toISOString(),
          // La op. E lo devuelve como numero, no como cadena.
          destinatario_id: Number(p.recipientId),
          tienda: p.store,
          trackings: [],
        };
      }),
    },
    'Consulta exitosa.',
  );
}

// --- Transporte --------------------------------------------------------------

/** Tracking implicado en la llamada, para resolver los fallos programados. */
function trackingOf(path: string, body: unknown): string | null {
  if (path.startsWith('/api/casillero/consulta-estado/')) {
    return decodeURIComponent(path.slice('/api/casillero/consulta-estado/'.length));
  }
  if (typeof body === 'object' && body !== null && 'tracking' in body) {
    const value = (body as { tracking?: unknown }).tracking;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/**
 * Sustituto del `fetch` a Helga. Devuelve un `Response` de verdad para que
 * `helga.client` no distinga la simulacion del proveedor real: mismo cuerpo,
 * mismos codigos, mismas trampas.
 *
 * Lanza (en vez de responder) cuando hay un fallo programado con status 0: eso
 * simula la red caida o el timeout, que el cliente traduce a `unavailable`.
 */
export async function mockHelgaRequest(
  method: 'POST' | 'DELETE',
  path: string,
  body: unknown,
): Promise<Response> {
  const [rawPath = '', query = ''] = path.split('?');
  const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const failure = takeFailure(trackingOf(rawPath, body));
  if (failure) {
    const detail = failure.message ?? 'Fallo simulado desde /api/dev/helga/fail.';
    if (failure.status === 0) throw new Error(`[helga:sim] timeout simulado en ${rawPath}`);
    return errorResponse(failure.status, detail);
  }

  if (method === 'DELETE') {
    const prefix = '/api/casillero/prealertas/';
    if (rawPath.startsWith(prefix)) {
      return opDeletePrealert(decodeURIComponent(rawPath.slice(prefix.length)));
    }
    return errorResponse(404, `Ruta simulada desconocida: DELETE ${rawPath}`);
  }

  if (rawPath === '/api/casillero/destinatarios') return opCreateRecipient(payload);
  if (rawPath === '/api/v2/prealertas') return opCreatePrealert(payload);
  if (rawPath.startsWith('/api/casillero/consulta-estado/')) {
    return opPackageState(decodeURIComponent(rawPath.slice('/api/casillero/consulta-estado/'.length)));
  }
  if (rawPath === '/api/casillero/despachos/preliquidaciones/paqsdisponibles') {
    const page = Number(new URLSearchParams(query).get('page') ?? '1');
    return opAvailablePackages(Number.isFinite(page) && page > 0 ? page : 1, payload);
  }

  return errorResponse(404, `Ruta simulada desconocida: POST ${rawPath}`);
}

// --- Panel de control (lo usan las rutas dev) --------------------------------

/** Foto del mundo, con el estado ya calculado de cada paquete. */
export function mockSnapshot() {
  const w = getWorld();
  return {
    stepMs: helgaSimulatedStepMs,
    recipients: w.recipients,
    packages: w.packages.map((p) => ({
      ...p,
      startedAt: new Date(p.startedAt).toISOString(),
      step: currentStep(p),
      state: currentState(p) ?? 'SIN ESTADO (404)',
      discoverable: currentState(p) === DISCOVERY_STATE,
    })),
    failures: w.failures,
  };
}

/**
 * Inyecta un paquete que NUNCA se prealerto: es la unica forma de probar el
 * descubrimiento (flujo 2), porque la op. E es el unico canal por el que aparece
 * algo que nuestra BD no conoce.
 */
export function mockInjectPackage(input: {
  tracking: string;
  recipientId: string;
  content?: string;
  store?: string;
  declaredValue?: number;
  /** Fija el paquete en DIGITADO para que no se escape de la ventana de captura. */
  hold?: boolean;
}): MockPackage {
  const w = getWorld();
  const tracking = input.tracking.trim();
  const existing = w.packages.find((p) => p.tracking === tracking);
  if (existing) throw new Error(`El tracking ${tracking} ya existe en el mundo simulado.`);
  // Un id desconocido no se rechaza: lo normal es copiarlo del `helgaClientId` de
  // un cliente nuestro, que puede ser anterior a este mundo simulado.
  ensureRecipient(input.recipientId);

  const seq = w.nextPrealert;
  w.nextPrealert += 1;
  const pkg: MockPackage = {
    tracking,
    hawb: `SIM${String(9_000_000 + seq)}`,
    recipientId: input.recipientId,
    content: input.content?.trim() || 'COMPRA NO DECLARADA',
    store: input.store?.trim() || 'POR DEFINIR',
    commercialValue: input.declaredValue ?? 0,
    insuredValue: 0,
    tariffPosition: HELGA_DEFAULT_TARIFF_POSITION,
    // Sin prealerta: nacio en la interfaz del proveedor, no en la nuestra.
    prealertId: null,
    // El reloj arranca un paso atras para que ya este en DIGITADO y la op. E lo
    // liste en la proxima corrida del descubrimiento.
    startedAt: Date.now() - helgaSimulatedStepMs,
    pinnedState: input.hold ? DISCOVERY_STATE : null,
    reportedLocker: null,
  };
  w.packages.push(pkg);
  saveWorld();
  return pkg;
}

/**
 * Mueve un paquete a mano: fija un estado concreto (incluye incidencias y estados
 * inventados, para probar esas ramas), lo adelanta N pasos del reloj, o cambia el
 * sub-casillero que reporta el proveedor (para disparar `checkLockerMatch`).
 */
export function mockAdvancePackage(input: {
  tracking: string;
  state?: string | null;
  steps?: number;
  locker?: string | null;
}): MockPackage {
  const w = getWorld();
  const pkg = w.packages.find((p) => p.tracking === input.tracking.trim());
  if (!pkg) throw new Error(`El tracking ${input.tracking} no existe en el mundo simulado.`);

  // `state: null` explicito devuelve el paquete al reloj.
  if (input.state !== undefined) pkg.pinnedState = input.state?.trim() || null;
  if (input.locker !== undefined) pkg.reportedLocker = input.locker?.trim() || null;
  // Adelantar N pasos = retroceder el arranque del reloj N pasos.
  if (input.steps) pkg.startedAt -= input.steps * helgaSimulatedStepMs;

  saveWorld();
  return pkg;
}

/** Programa un fallo para las proximas llamadas (403, 422, o 0 = timeout). */
export function mockAddFailure(failure: MockFailure): void {
  const w = getWorld();
  w.failures.push(failure);
  saveWorld();
}

/** Vacia el mundo simulado. */
export function mockReset(): void {
  world = emptyWorld();
  saveWorld();
  console.info('[helga:sim] mundo reiniciado.');
}
