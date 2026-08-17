/**
 * Seed MASIVO para pruebas reales de carga: miles de casilleros y decenas de
 * miles de tramites con su historial, costos, pagos y entregas.
 *
 * No sustituye al de demo, lo complementa. El de demo siembra POCO y EXHAUSTIVO
 * (un tramite por estado, un caso por regla) para ver el producto entero; este
 * siembra MUCHO y REALISTA para ver como se comporta: si los indices aguantan,
 * si el listado pagina, si el reporte del mes sale en un segundo o en veinte.
 * Por eso aqui la mezcla imita la operacion (mucha paqueteria entregada, poca
 * carga maritima en aduanas) en vez de cubrir cada rama del dominio.
 *
 * Cinco decisiones que lo hacen util como banco de pruebas y no solo grande:
 *   1. Es REPRODUCIBLE: nada sale de `Math.random`, todo de una semilla
 *      (`SEED_BULK_SEED`). Dos corridas con la misma semilla dan exactamente la
 *      misma base, asi que "el reporte tarda 4 s" es una medicion comparable.
 *   2. La ANTIGUEDAD es coherente con el estado: lo entregado se reparte por
 *      todo el historico y lo que sigue en proceso ocurrio hace dias. Sin eso,
 *      la mitad del tablero serian paquetes "En aduanas" desde hace un año.
 *   3. Los casilleros no reciben lo mismo: unos pocos concentran la mayoria de
 *      los tramites, como en la vida real. Es lo que hace que el indice de
 *      "mis paquetes" se pruebe de verdad.
 *   4. El dinero cumple las mismas reglas que produccion: cada linea y cada pago
 *      con su moneda (M2) y su tasa (M5), los totales por `computeTotals` (M4).
 *   5. Todo historial se valida contra la maquina de estados y todo tramite que
 *      salio a ruta cumple `isSettled`, con las mismas funciones que usa la API.
 *
 * Se reconoce por dos marcas, y eso es lo que permite que `--reset` borre solo
 * lo suyo: los usuarios usan el dominio `@bulk.hsglobal.ltd` y TODOS los
 * trackings empiezan por `BLK` (los tramites sin dueño de la sala de control no
 * cuelgan de ningun casillero, asi que el tracking es su unica marca).
 *
 * Uso: pnpm --filter @courier/api db:seed:bulk
 *      pnpm --filter @courier/api db:seed:bulk -- --reset
 *      pnpm --filter @courier/api db:seed:bulk -- --append --shipments=50000
 *
 * Requiere haber corrido antes `db:seed` (necesita las tarifas de cliente).
 */
import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { eq, gte, inArray, like } from 'drizzle-orm';
import {
  CARRIERS,
  ClientReviewStatus,
  CostLineSource,
  Currency,
  DeliveryOutcome,
  Flow,
  HelgaSyncStatus,
  PROVINCES,
  PaymentMethod,
  PaymentStatus,
  Principal,
  Role,
  STORES,
  ShipmentType,
  State,
  UserStatus,
  applyPercentage,
  bankAccountsFor,
  categoryForLine,
  computeTotals,
  flowForType,
  formatShipmentCode,
  isSettled,
  percentageBase,
  roundMoney,
  statesOf,
} from '@courier/shared';
import type { BankAccount, CostCategory } from '@courier/shared';
import { db } from './core/db';
import { clients, users } from './modules/auth/auth.schema';
import { costServices } from './modules/cost-services/cost-service.schema';
import { shipmentCosts } from './modules/costs/shipment-cost.schema';
import { deliveryAttempts } from './modules/deliveries/deliveries.schema';
import { payments } from './modules/payments/payments.schema';
import { districtRoutes } from './modules/routes/district-route.schema';
import {
  SETTINGS_ROW_ID,
  appSettings,
  exchangeRateHistory,
  freightRateHistory,
} from './modules/settings/settings.schema';
import { shipmentEvents, shipments } from './modules/shipments/shipments.schema';
import { clientRates } from './modules/tariffs/tariffs.schema';
import {
  COST_SERVICES,
  DEFAULT_EXCHANGE_RATE,
  DEFAULT_FREIGHT_RATE,
  Rng,
  type Tx,
  assertPath,
  insertChunked,
  locationOf,
  nextSequence,
  pathTo,
  usdToCoverCrc,
} from './seed-support';

// ---------------------------------------------------------------------------
// 1. Parametros
// ---------------------------------------------------------------------------

/** Bandera suelta de linea de comandos (`-- --reset`). */
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/**
 * Numero configurable, por variable de entorno o por `--flag=valor`. Las dos
 * formas porque exportar variables en PowerShell es incomodo y este seed se
 * corre justamente probando tamaños distintos.
 */
function option(name: string, envName: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  const raw = arg ? arg.slice(name.length + 3) : process.env[envName];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`[seed-bulk] Valor inválido para --${name} / ${envName}: ${raw}`);
  }
  return value;
}

const CLIENTS_N = option('clients', 'SEED_BULK_CLIENTS', 2_000);
const SHIPMENTS_N = option('shipments', 'SEED_BULK_SHIPMENTS', 20_000);
const STAFF_N = option('staff', 'SEED_BULK_STAFF', 24);
/** Meses de historia hacia atras que cubre la siembra. */
const MONTHS = option('months', 'SEED_BULK_MONTHS', 18);
/** Semilla del generador: misma semilla, misma base. */
const SEED = option('seed', 'SEED_BULK_SEED', 20_260_816);

const BULK_DOMAIN = 'bulk.hsglobal.ltd';
const BULK_PASSWORD = process.env.SEED_BULK_PASSWORD ?? 'Bulk1234!';

/** Prefijo de TODOS los trackings sembrados aqui: es la marca de borrado. */
const TRACKING_PREFIX = 'BLK';
/**
 * Banda de numeros de ruta que usa este seed (una ruta por canton, 100 en
 * adelante). Las rutas reales y las de demo viven en numeros bajos, asi que la
 * banda alta se puede borrar entera sin tocar lo que definio un administrador.
 */
const ROUTE_BASE = 100;
/**
 * Base de las cedulas sembradas. Empiezan por 9, que no es provincia valida en
 * una cedula nacional: ningun documento real puede chocar con estos.
 */
const ID_BASE = 900_000_000;

/**
 * Filas por sentencia. Un INSERT manda un parametro por celda y Postgres corta
 * en 65.535, asi que la tanda se acota por el ancho de cada tabla (`shipments`
 * es la mas ancha, con ~45 columnas).
 */
const CHUNK = {
  users: 800,
  clients: 600,
  shipments: 400,
  events: 2_000,
  costs: 1_200,
  payments: 800,
  attempts: 2_000,
  routes: 2_000,
} as const;

/** Tramites por vuelta del bucle principal. Acota la memoria del proceso. */
const BATCH = 2_000;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date();
const HISTORY_START = NOW.getTime() - MONTHS * 30 * DAY;

// ---------------------------------------------------------------------------
// 2. Vocabulario (de aqui salen nombres, direcciones y descripciones)
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'Laura', 'Mario', 'Silvia', 'Randall', 'Karla', 'Esteban', 'Natalia', 'Gerardo',
  'Andrea', 'Óscar', 'Vanessa', 'Jorge', 'Marcela', 'Diego', 'Paola', 'Alonso',
  'Cristina', 'Fabián', 'Gabriela', 'Rodrigo', 'Melissa', 'Álvaro', 'Tatiana',
  'Kenneth', 'Priscilla', 'Josué', 'Mariana', 'Sebastián', 'Ericka', 'Wilson',
  'Adriana', 'Roberto', 'Yendry', 'Maikol', 'Xinia', 'Bryan', 'Rebeca', 'Hazel',
] as const;

const LAST_NAMES = [
  'Jiménez', 'Solano', 'Arias', 'Quirós', 'Venegas', 'Rojas', 'Brenes', 'Mora',
  'Picado', 'Fallas', 'Leiva', 'Badilla', 'Chinchilla', 'Zamora', 'Vindas',
  'Cascante', 'Montero', 'Aguilar', 'Bonilla', 'Calderón', 'Delgado', 'Esquivel',
  'Fernández', 'Gómez', 'Hernández', 'Induni', 'Loría', 'Madrigal', 'Navarro',
  'Obando', 'Porras', 'Ramírez', 'Salas', 'Trejos', 'Ureña', 'Valverde', 'Wong',
] as const;

/** Punto de referencia de la direccion: en Costa Rica se navega por señas. */
const LANDMARKS = [
  'de la iglesia católica', 'del parque central', 'de la escuela pública',
  'del supermercado', 'de la plaza de deportes', 'del Banco Nacional',
  'de la gasolinera', 'del EBAIS', 'de la panadería', 'del salón comunal',
  'de la entrada principal', 'del puente', 'de la ferretería', 'del cementerio',
] as const;

const HOUSE_HINTS = [
  'casa color verde', 'portón negro', 'casa esquinera', 'apartamento 2B',
  'edificio de dos plantas', 'condominio Los Robles, casa 14', 'tapia gris',
  'local comercial a mano derecha', 'casa con verjas blancas', 'último portón',
] as const;

const PACKAGE_ITEMS = [
  'Audífonos inalámbricos', 'Tenis deportivos', 'Ropa de bebé', 'Cafetera programable',
  'Repuestos de bicicleta', 'Set de maquillaje', 'Pulsera de plata', 'Teclado mecánico',
  'Vitaminas y suplementos', 'Juego de toallas', 'Pijamas', 'Taladro inalámbrico',
  'Consola de videojuegos', 'Cargador y cables USB', 'Bolso de mano', 'Reloj deportivo',
  'Filtros de agua', 'Camisetas de algodón', 'Libros de texto', 'Lentes de sol',
  'Termo de acero', 'Repuesto de licuadora', 'Cámara de seguridad', 'Tenis de correr',
] as const;

const CARGO_ITEMS = [
  'Contenedor 40 pies con repuestos automotrices', 'Maquinaria industrial',
  'Lote de textiles para confección', 'Equipo médico', 'Insumos agrícolas',
  'Mobiliario de oficina', 'Paneles solares', 'Repuestos electrónicos',
  'Materiales de construcción', 'Línea blanca para distribuidor',
  'Llantas para vehículo liviano', 'Insumos plásticos para empaque',
] as const;

const WAREHOUSES = [
  'Bodega Fiscal Alajuela 7', 'Bodega Fiscal Santamaría 2', 'Bodega Fiscal Caldera 4',
  'Bodega Fiscal Moín 1', 'Bodega Fiscal La Uruca 3', 'Bodega Fiscal Barranca 5',
] as const;

/** Roles del staff, en el orden en que se reparten (el primero siempre es admin). */
const STAFF_ROLES: readonly Role[] = [
  Role.Operativo,
  Role.Mensajeria,
  Role.ServicioCliente,
  Role.Mensajeria,
  Role.Financiero,
  Role.Operativo,
  Role.ServicioCliente,
  Role.Mensajeria,
];

/**
 * Mezcla de tipos de tramite: la operacion es sobre todo paqueteria, y la carga
 * pesada, aunque factura mucho mas por unidad, son unos pocos casos al mes.
 */
const TYPE_MIX: readonly { type: ShipmentType; weight: number }[] = [
  { type: ShipmentType.Paqueteria, weight: 78 },
  { type: ShipmentType.Aereo, weight: 7 },
  { type: ShipmentType.MaritimoLCL, weight: 6 },
  { type: ShipmentType.Agenciamiento, weight: 5 },
  { type: ShipmentType.MaritimoFCL, weight: 4 },
];

/** Reparto de provincias por volumen: el GAM concentra la mayoria de entregas. */
const PROVINCE_MIX: readonly { code: string; weight: number }[] = [
  { code: '1', weight: 34 }, // San José
  { code: '2', weight: 20 }, // Alajuela
  { code: '4', weight: 15 }, // Heredia
  { code: '3', weight: 13 }, // Cartago
  { code: '5', weight: 7 }, //  Guanacaste
  { code: '6', weight: 6 }, //  Puntarenas
  { code: '7', weight: 5 }, //  Limón
];

/** Dias que tarda cada paso del historial, por flujo (minimo y maximo). */
const STEP_DAYS: Record<Flow, readonly [number, number]> = {
  [Flow.Paqueteria]: [1, 4],
  [Flow.Transporte]: [3, 9],
  [Flow.Agenciamiento]: [2, 7],
};

// ---------------------------------------------------------------------------
// 3. Helpers
// ---------------------------------------------------------------------------

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Correo tecnico: sin tildes ni espacios, y con el indice que lo hace unico. */
const slug = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const TYPE_WEIGHTS = TYPE_MIX.map((t) => t.weight);
const PROVINCE_WEIGHTS = PROVINCE_MIX.map((p) => p.weight);

/**
 * Pesos de estado final dentro de un flujo. Se derivan del propio flujo (no hay
 * una lista de estados escrita a mano) para que agregar un estado al dominio no
 * deje aqui un hueco silencioso: entra en el reparto con su peso por posicion.
 *
 * La forma es la de la operacion: la enorme mayoria ya se entrego, y de lo que
 * sigue vivo hay mas en los tramos finales (facturacion, pendiente de pago) que
 * en los primeros, porque ahi es donde los tramites se estancan.
 *
 * Se calcula una vez por flujo, no una por tramite: son tres flujos y decenas de
 * miles de sorteos.
 */
const STATE_MIX = new Map<Flow, { states: readonly State[]; weights: number[] }>(
  Object.values(Flow).map((flow) => {
    const states = statesOf(flow);
    const weights = states.map((state, i) => {
      if (state === State.Entregado) return 250;
      if (state === State.DevueltoBodega) return 6;
      return 4 + i * 3;
    });
    return [flow, { states, weights }];
  }),
);

/** Instantes de cada paso del historial, ascendentes, entre dos limites. */
function timeline(rng: Rng, from: number, to: number, steps: number): Date[] {
  if (steps === 1) return [new Date(from)];
  const step = (to - from) / (steps - 1);
  return Array.from({ length: steps }, (_, i) => {
    // Jitter acotado a un tercio del paso: desordena la cadencia sin adelantar
    // un evento al siguiente, que es lo unico que el historial no tolera.
    const jitter = i === 0 || i === steps - 1 ? 0 : rng.next() * step * 0.33;
    return new Date(Math.round(from + step * i + jitter));
  });
}

/** Casillero del pool, tal como lo necesita la generacion de tramites. */
interface PoolClient {
  id: string;
  /** Instante de alta: ningun tramite suyo puede ser anterior. */
  createdAt: number;
  /** Precio por kg de su tarifa, en USD: es el flete de cada paquete. */
  pricePerKg: number;
}

/** Servicio del catalogo, con lo que la linea de costo le copia como snapshot. */
interface ServiceRef {
  id: string;
  category: CostCategory;
  electronicInvoiceCode: string | null;
}

// ---------------------------------------------------------------------------
// 4. Borrado
// ---------------------------------------------------------------------------

/** Borra SOLO lo que sembro este archivo. Nunca toca datos reales ni de demo. */
async function resetBulk(tx: Tx): Promise<void> {
  // Los tramites primero: no caen con el casillero (la FK no tiene cascade) y
  // los que estan sin dueño no cuelgan de ninguno. El tracking los cubre a los
  // dos, y su borrado si arrastra eventos, costos, pagos y entregas.
  await tx.delete(shipments).where(like(shipments.tracking, `${TRACKING_PREFIX}%`));

  const bulkUsers = await tx
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${BULK_DOMAIN}`));
  const ids = bulkUsers.map((u) => u.id);
  for (let i = 0; i < ids.length; i += 1_000) {
    await tx.delete(users).where(inArray(users.id, ids.slice(i, i + 1_000)));
  }

  // Rutas: solo la banda alta, que es la que asigna este seed. Las rutas que
  // definio un administrador (o el seed de demo) viven en numeros bajos.
  await tx.delete(districtRoutes).where(gte(districtRoutes.routeNumber, ROUTE_BASE));

  // El catalogo de servicios, la tasa vigente y las tarifas NO se tocan: son
  // configuracion del sistema, no volumen de prueba. Este seed los usa; el que
  // los siembra (y por tanto el que los borra) es `db:seed` / `db:seed:demo`.
  console.log(`[seed-bulk] Datos masivos anteriores eliminados (${ids.length} usuarios).`);
}

// ---------------------------------------------------------------------------
// 5. Siembra
// ---------------------------------------------------------------------------

async function seed(tx: Tx): Promise<void> {
  const reset = flag('reset') || process.env.SEED_BULK_RESET === '1';
  const append = flag('append') || process.env.SEED_BULK_APPEND === '1';
  const started = Date.now();
  const rng = new Rng(SEED);

  const [existing] = await tx
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${BULK_DOMAIN}`))
    .limit(1);
  if (existing && !reset && !append) {
    console.log('[seed-bulk] Ya hay datos masivos sembrados. No se cambió nada.');
    console.log('  Para borrarlos y volver a sembrarlos: agrega -- --reset');
    console.log('  Para agregar más volumen encima:      agrega -- --append');
    return;
  }
  if (reset) await resetBulk(tx);

  // Borrar sin resembrar: `-- --reset --clients=0 --shipments=0`. Es la forma de
  // devolver la base al estado anterior a la prueba sin dejar rastro (ni el
  // staff, que si no se crearia de nuevo para una siembra que no va a ocurrir).
  if (reset && CLIENTS_N === 0 && SHIPMENTS_N === 0) {
    console.log('[seed-bulk] Solo borrado: no se sembró nada nuevo.');
    return;
  }

  // --- Tarifas de cliente: las siembra `db:seed`, aqui solo se usan ---
  const rates = await tx.select().from(clientRates);
  if (rates.length === 0) {
    throw new Error('[seed-bulk] No hay tarifas de cliente. Corre primero: pnpm --filter @courier/api db:seed');
  }
  const defaultRate = rates.find((r) => r.isDefault) ?? rates[0]!;
  const rateById = new Map(rates.map((r) => [r.id, r]));

  // --- Staff ---
  const passwordHash = await hash(BULK_PASSWORD);
  const staffRows = await ensureStaff(tx, rng, passwordHash);
  const byRole = (role: Role): string[] => staffRows.filter((s) => s.role === role).map((s) => s.id);
  const adminIds = byRole(Role.Admin);
  const agentIds = byRole(Role.ServicioCliente);
  const opsIds = byRole(Role.Operativo);
  const financeIds = byRole(Role.Financiero);
  const courierIds = byRole(Role.Mensajeria);
  // Hace falta uno de verdad: es quien queda como autor si este seed tiene que
  // fijar la tasa de cambio, y esa fila apunta al usuario por clave foránea.
  const adminId = adminIds[0];
  if (!adminId) throw new Error('[seed-bulk] No hay ningún administrador en el staff sembrado.');

  // --- Catalogo de servicios de costo (solo si nadie lo ha sembrado) ---
  const services = await ensureCostServices(tx);

  // --- Tasa de cambio y tarifa de flete vigentes (solo si no habia) ---
  const exchangeRate = await ensureRates(tx, adminId);

  // --- Rutas: una por canton, para que toda direccion tenga ruta de entrega ---
  await seedRoutes(tx);

  // --- Casilleros ---
  const pool = await seedClients(tx, rng, passwordHash, defaultRate, rates, rateById, append);
  if (pool.length === 0 && SHIPMENTS_N > 0) {
    throw new Error('[seed-bulk] No hay casilleros a los que asignar trámites (usa --clients=N).');
  }
  // Los mas antiguos primero: el sorteo carga la mano en el inicio del pool, y
  // asi los clientes con mas volumen son tambien los que llevan mas tiempo.
  pool.sort((a, b) => a.createdAt - b.createdAt);

  // --- Tramites, por tandas ---
  const totals = { shipments: 0, events: 0, costs: 0, payments: 0, attempts: 0, unassigned: 0 };
  for (let done = 0; done < SHIPMENTS_N; done += BATCH) {
    const size = Math.min(BATCH, SHIPMENTS_N - done);
    const codes = await nextSequence(tx, 'hs_shipment_code_seq', size);

    const shipmentRows: (typeof shipments.$inferInsert)[] = [];
    const eventRows: (typeof shipmentEvents.$inferInsert)[] = [];
    const costRows: (typeof shipmentCosts.$inferInsert)[] = [];
    const paymentRows: (typeof payments.$inferInsert)[] = [];
    const attemptRows: (typeof deliveryAttempts.$inferInsert)[] = [];

    for (let k = 0; k < size; k++) {
      buildShipment({
        rng,
        // El consecutivo de la secuencia, no el indice del bucle: es lo unico
        // que sigue siendo unico cuando se agrega volumen con `--append`, y de
        // el cuelgan el tracking, el HAWB y la referencia de pasarela, que la
        // base exige unicos.
        seq: codes[k]!,
        code: formatShipmentCode(codes[k]!),
        pool,
        services,
        exchangeRate,
        staff: { adminIds, agentIds, opsIds, financeIds, courierIds },
        out: { shipmentRows, eventRows, costRows, paymentRows, attemptRows },
      });
    }

    await insertChunked(tx, shipments, shipmentRows, CHUNK.shipments);
    await insertChunked(tx, shipmentEvents, eventRows, CHUNK.events);
    await insertChunked(tx, shipmentCosts, costRows, CHUNK.costs);
    await insertChunked(tx, payments, paymentRows, CHUNK.payments);
    await insertChunked(tx, deliveryAttempts, attemptRows, CHUNK.attempts);

    totals.shipments += shipmentRows.length;
    totals.events += eventRows.length;
    totals.costs += costRows.length;
    totals.payments += paymentRows.length;
    totals.attempts += attemptRows.length;
    totals.unassigned += shipmentRows.filter((s) => s.clientId == null).length;

    const elapsed = (Date.now() - started) / 1000;
    console.log(
      `[seed-bulk] trámites ${totals.shipments}/${SHIPMENTS_N}` +
        `  (${Math.round(totals.shipments / Math.max(elapsed, 0.001))}/s, ${elapsed.toFixed(1)} s)`,
    );
  }

  // --- Resumen ---
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n[seed-bulk] Datos masivos sembrados:');
  console.log(`  usuarios staff:      ${staffRows.length}`);
  console.log(`  casilleros:          ${pool.length} en el pool`);
  console.log(`  trámites:            ${totals.shipments} (${totals.unassigned} sin dueño, sala de control)`);
  console.log(`  eventos de estado:   ${totals.events}`);
  console.log(`  líneas de costo:     ${totals.costs}`);
  console.log(`  pagos:               ${totals.payments}`);
  console.log(`  intentos de entrega: ${totals.attempts}`);
  console.log(`  tiempo:              ${seconds} s`);
  console.log(`\n  Semilla: ${SEED} (misma semilla, misma base)`);
  console.log(`  Todos los usuarios entran con la clave: ${BULK_PASSWORD}`);
  console.log(`  Correos: <nombre>.<apellido><n>@${BULK_DOMAIN}`);
  console.log('');
}

/**
 * Staff de la prueba. Si ya hay staff masivo (caso `--append`) se reutiliza: no
 * tiene sentido acumular mensajeros cada vez que se agrega volumen.
 */
async function ensureStaff(
  tx: Tx,
  rng: Rng,
  passwordHash: string,
): Promise<{ id: string; role: Role }[]> {
  const existing = await tx
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(like(users.email, `%@${BULK_DOMAIN}`));
  const staff = existing.filter((u) => u.role !== Role.Client);
  if (staff.length > 0) return staff as { id: string; role: Role }[];

  if (STAFF_N < STAFF_ROLES.length + 1) {
    throw new Error(`[seed-bulk] --staff debe ser al menos ${STAFF_ROLES.length + 1} (uno por rol).`);
  }

  const rows = Array.from({ length: STAFF_N }, (_, i) => {
    const role = i === 0 ? Role.Admin : STAFF_ROLES[(i - 1) % STAFF_ROLES.length]!;
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    return {
      email: `${slug(first)}.${slug(last)}${i}@${BULK_DOMAIN}`,
      passwordHash,
      principal: Principal.Staff,
      role,
      name: `${first} ${last}`,
      phone: `8${rng.int(1_000_000, 9_999_999)}`,
      status: rng.chance(0.94) ? UserStatus.Activo : UserStatus.Inactivo,
      emailVerifiedAt: new Date(HISTORY_START - 30 * DAY),
      createdAt: new Date(HISTORY_START - 30 * DAY),
    };
  });
  await insertChunked(tx, users, rows, CHUNK.users);

  const created = await tx
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(like(users.email, `%@${BULK_DOMAIN}`));
  return created.filter((u) => u.role !== Role.Client) as { id: string; role: Role }[];
}

/**
 * Catalogo de servicios: se usa el que ya exista. Solo si la tabla esta vacia se
 * siembra el del dominio compartido, para que este seed funcione sobre una base
 * recien migrada sin depender del de demo. Nunca se borra desde aqui.
 */
async function ensureCostServices(tx: Tx): Promise<Map<string, ServiceRef>> {
  const read = async (): Promise<Map<string, ServiceRef>> => {
    const rows = await tx
      .select({
        id: costServices.id,
        name: costServices.name,
        category: costServices.category,
        electronicInvoiceCode: costServices.electronicInvoiceCode,
      })
      .from(costServices);
    return new Map(
      rows.map((r) => [
        r.name,
        { id: r.id, category: r.category, electronicInvoiceCode: r.electronicInvoiceCode },
      ]),
    );
  };

  const current = await read();
  if (current.size > 0) return current;

  await tx.insert(costServices).values(
    COST_SERVICES.map((s) => ({
      name: s.name,
      kind: s.kind,
      category: s.category,
      electronicInvoiceCode: s.electronicInvoiceCode,
      valueType: s.valueType,
      defaultValue: s.defaultValue,
      currency: s.currency,
      enabled: s.enabled ?? true,
    })),
  );
  console.log('[seed-bulk] Catálogo de servicios de costo sembrado (la tabla estaba vacía).');
  return read();
}

/**
 * Tasa de cambio y tarifa de flete vigentes. Solo se siembran si el sistema no
 * tenia ninguna: son valores UNICOS que fija un administrador, y pisarlos seria
 * cambiarle el dinero al sistema, no agregarle volumen de prueba. Devuelve la
 * tasa vigente, que es la que se congela en todo el dinero sembrado (M5).
 */
async function ensureRates(tx: Tx, adminId: string): Promise<number> {
  const setAt = new Date(HISTORY_START - 30 * DAY);
  const seeded = await tx
    .insert(appSettings)
    .values({
      id: SETTINGS_ROW_ID,
      exchangeRate: DEFAULT_EXCHANGE_RATE,
      exchangeRateSetBy: adminId,
      exchangeRateSetAt: setAt,
      freightRateUsdPerLb: DEFAULT_FREIGHT_RATE,
      freightRateSetBy: adminId,
      freightRateSetAt: setAt,
      updatedAt: setAt,
    })
    .onConflictDoNothing()
    .returning({ id: appSettings.id });

  if (seeded.length > 0) {
    // Una tasa vigente sin el rastro de quien la puso no existe en este sistema.
    await tx.insert(exchangeRateHistory).values({
      rate: DEFAULT_EXCHANGE_RATE,
      previousRate: null,
      note: 'Tasa inicial de la prueba de carga.',
      setBy: adminId,
      setAt,
    });
    await tx.insert(freightRateHistory).values({
      usdPerLb: DEFAULT_FREIGHT_RATE,
      previousUsdPerLb: null,
      note: 'Tarifa inicial de la prueba de carga.',
      setBy: adminId,
      setAt,
    });
  }

  const [current] = await tx
    .select({ rate: appSettings.exchangeRate })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ROW_ID))
    .limit(1);
  return current?.rate ?? DEFAULT_EXCHANGE_RATE;
}

/**
 * Una ruta por canton, aplicada a todos sus distritos. Sin esto, las direcciones
 * de miles de casilleros repartidos por el pais quedarian sin ruta y la pantalla
 * de entregas se probaria contra una sola ruta.
 *
 * `onConflictDoNothing`: el distrito que ya tenga ruta propia (definida por un
 * administrador o por el seed de demo) la conserva, porque la ruta del distrito
 * manda sobre cualquier asignacion masiva.
 */
async function seedRoutes(tx: Tx): Promise<void> {
  const rows: (typeof districtRoutes.$inferInsert)[] = [];
  let cantonIndex = 0;
  for (const province of PROVINCES) {
    for (const canton of province.cantons) {
      const routeNumber = ROUTE_BASE + cantonIndex++;
      for (const district of canton.districts) {
        rows.push({ districtCode: district.code, routeNumber });
      }
    }
  }
  for (let i = 0; i < rows.length; i += CHUNK.routes) {
    await tx.insert(districtRoutes).values(rows.slice(i, i + CHUNK.routes)).onConflictDoNothing();
  }
  console.log(`[seed-bulk] Rutas: ${rows.length} distritos en ${cantonIndex} rutas (${ROUTE_BASE}+).`);
}

/**
 * Casilleros nuevos, mas los que ya existan si se esta agregando volumen
 * (`--append`): el pool sobre el que se reparten los tramites.
 */
async function seedClients(
  tx: Tx,
  rng: Rng,
  passwordHash: string,
  defaultRate: typeof clientRates.$inferSelect,
  rates: (typeof clientRates.$inferSelect)[],
  rateById: Map<string, typeof clientRates.$inferSelect>,
  append: boolean,
): Promise<PoolClient[]> {
  const pool: PoolClient[] = [];
  let offset = 0;

  if (append) {
    const existing = await tx
      .select({
        id: clients.id,
        createdAt: clients.createdAt,
        clientRateId: clients.clientRateId,
      })
      .from(clients)
      .innerJoin(users, eq(clients.userId, users.id))
      .where(like(users.email, `%@${BULK_DOMAIN}`));
    for (const row of existing) {
      const rate = (row.clientRateId ? rateById.get(row.clientRateId) : undefined) ?? defaultRate;
      pool.push({ id: row.id, createdAt: row.createdAt.getTime(), pricePerKg: rate.pricePerKg });
    }
    // El indice del correo y de la cedula continua donde quedo la corrida
    // anterior: los dos son unicos y no pueden reciclarse.
    offset = existing.length;
    console.log(`[seed-bulk] Casilleros existentes reutilizados: ${offset}.`);
  }

  if (CLIENTS_N === 0) return pool;

  const codes = await nextSequence(tx, 'hs_client_code_seq', CLIENTS_N);
  const spread = MONTHS * 30 - 3;
  const userRows: (typeof users.$inferInsert)[] = [];
  const clientRows: (typeof clients.$inferInsert)[] = [];

  for (let i = 0; i < CLIENTS_N; i++) {
    const n = offset + i;
    const userId = randomUUID();
    const clientId = randomUUID();
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const secondLast = rng.pick(LAST_NAMES);

    // Los primeros del pool son los mas antiguos: el sorteo de tramites carga
    // la mano en el inicio, asi que los clientes veteranos son los que mas
    // volumen tienen, como en la operacion real.
    const memberSinceDays = 3 + Math.round(((CLIENTS_N - i) / CLIENTS_N) * spread) + rng.int(0, 5);
    const createdAt = new Date(NOW.getTime() - memberSinceDays * DAY);

    const province = PROVINCE_MIX[rng.weightedIndex(PROVINCE_WEIGHTS)]!;
    const cantons = PROVINCES.find((p) => p.code === province.code)!.cantons;
    const district = rng.pick(rng.pick(cantons).districts);

    const rate = rng.chance(0.55) ? defaultRate : rng.pick(rates);
    const helga = rng.chance(0.88)
      ? HelgaSyncStatus.Synced
      : rng.chance(0.6)
        ? HelgaSyncStatus.Pending
        : HelgaSyncStatus.Failed;
    const synced = helga === HelgaSyncStatus.Synced;
    const seq = codes[i]!;
    const verified = rng.chance(0.96);
    const creditLimit = rng.chance(0.22)
      ? rng.chance(0.6)
        ? { amount: rng.int(200, 2_500), currency: Currency.USD }
        : { amount: rng.int(100_000, 1_200_000), currency: Currency.CRC }
      : null;

    userRows.push({
      id: userId,
      email: `${slug(first)}.${slug(last)}${n}@${BULK_DOMAIN}`,
      passwordHash,
      principal: Principal.Client,
      role: Role.Client,
      name: `${first} ${last} ${secondLast}`,
      phone: `8${rng.int(1_000_000, 9_999_999)}`,
      status: rng.chance(0.97) ? UserStatus.Activo : UserStatus.Inactivo,
      emailVerifiedAt: verified ? createdAt : null,
      createdAt,
    });

    clientRows.push({
      id: clientId,
      userId,
      code: `HS-${seq}`,
      idNumber: String(ID_BASE + n),
      ...locationOf(district.code),
      addressLine: `${rng.int(25, 800)} m ${rng.pick(['norte', 'sur', 'este', 'oeste'])} ${rng.pick(LANDMARKS)}, ${rng.pick(HOUSE_HINTS)}`,
      reviewStatus: rng.chance(0.82) ? ClientReviewStatus.Revisado : ClientReviewStatus.Nuevo,
      clientRateId: rate.id,
      // Techo de politica comercial: monto + moneda explicita, sin tasa (M2).
      // La mayoria no tiene limite definido, que es distinto de tenerlo en cero.
      // Monto y moneda salen del MISMO sorteo: un techo sin moneda no es un dato.
      creditLimit: creditLimit?.amount ?? null,
      creditLimitCurrency: creditLimit?.currency ?? null,
      helgaClientId: synced ? `HLG-${seq}` : null,
      helgaSubLocker: synced ? `SJO008835S${String(seq).slice(-3)}` : null,
      helgaSyncedAt: synced ? createdAt : null,
      helgaSyncStatus: helga,
      helgaSyncAttempts: helga === HelgaSyncStatus.Pending ? 0 : helga === HelgaSyncStatus.Failed ? 3 : 1,
      helgaLastError:
        helga === HelgaSyncStatus.Failed
          ? 'El proveedor rechazó la cédula: ya existe otro destinatario con ese documento.'
          : null,
      memberSince: isoDay(createdAt),
      createdAt,
    });

    pool.push({ id: clientId, createdAt: createdAt.getTime(), pricePerKg: rate.pricePerKg });
  }

  await insertChunked(tx, users, userRows, CHUNK.users);
  await insertChunked(tx, clients, clientRows, CHUNK.clients);
  console.log(`[seed-bulk] Casilleros sembrados: ${CLIENTS_N}.`);
  return pool;
}

// ---------------------------------------------------------------------------
// 6. Un tramite completo (historial, costos, pagos y entregas)
// ---------------------------------------------------------------------------

interface BuildArgs {
  rng: Rng;
  /** Consecutivo de negocio en crudo: la identidad unica de este tramite. */
  seq: string;
  code: string;
  pool: readonly PoolClient[];
  services: Map<string, ServiceRef>;
  exchangeRate: number;
  staff: {
    adminIds: string[];
    agentIds: string[];
    opsIds: string[];
    financeIds: string[];
    courierIds: string[];
  };
  out: {
    shipmentRows: (typeof shipments.$inferInsert)[];
    eventRows: (typeof shipmentEvents.$inferInsert)[];
    costRows: (typeof shipmentCosts.$inferInsert)[];
    paymentRows: (typeof payments.$inferInsert)[];
    attemptRows: (typeof deliveryAttempts.$inferInsert)[];
  };
}

function buildShipment(args: BuildArgs): void {
  const { rng, seq, code, pool, services, exchangeRate, staff, out } = args;
  const n = Number(seq);

  const type = TYPE_MIX[rng.weightedIndex(TYPE_WEIGHTS)]!.type;
  const flow = flowForType(type);
  const isPackage = type === ShipmentType.Paqueteria;

  const { states, weights } = STATE_MIX.get(flow)!;
  const finalState = states[rng.weightedIndex(weights)]!;
  const path = pathTo(flow, finalState);

  // Entrega fallida y reintento: sale a ruta, vuelve a bodega y se entrega. Es
  // poco frecuente pero es el unico camino que no es una linea recta, y solo
  // existe en Paqueteria: es el unico flujo con aristas fuera de la principal.
  const retried = flow === Flow.Paqueteria && finalState === State.Entregado && rng.chance(0.03);
  if (retried) {
    path.splice(path.length - 1, 0, State.DevueltoBodega, State.EnRutaEntrega);
    // `pathTo` ya valido la linea recta; el desvio se valida aparte.
    assertPath(flow, path);
  }

  /**
   * Paquete sin dueño: llego a la bodega sin que nadie lo anunciara y espera en
   * la sala de control a que se le identifique casillero. Solo tiene sentido en
   * Paqueteria y en los tramos antes de facturar.
   */
  const unassigned = isPackage && path.length >= 2 && path.length <= 5 && rng.chance(0.08);
  /**
   * Reparto de tramites entre casilleros: el exponente carga la mano en el
   * inicio del pool (que esta ordenado del mas antiguo al mas nuevo), asi que
   * unos pocos clientes concentran buena parte del volumen y la larga cola
   * apenas recibe. Un reparto plano dejaria a cada casillero con exactamente la
   * misma cantidad, que es justo el caso que nunca ocurre y el que menos exige
   * al indice de "mis paquetes".
   */
  const client = unassigned ? null : pool[Math.floor(pool.length * rng.next() ** 1.6)]!;

  // --- Cuando ocurrio cada paso ---
  const steps = path.length;
  const [minStep, maxStep] = STEP_DAYS[flow];
  const span = (minStep + rng.next() * (maxStep - minStep)) * (steps - 1) * DAY;
  const closed = finalState === State.Entregado || finalState === State.DevueltoBodega;
  const earliest = Math.max(HISTORY_START, (client?.createdAt ?? HISTORY_START) + DAY / 2);

  // Lo cerrado se reparte por todo el historico (con mas peso en lo reciente:
  // el negocio crece); lo que sigue vivo tuvo su ultimo movimiento hace dias,
  // porque un tramite abierto desde hace un año no existe en la operacion.
  let end = closed
    ? earliest + rng.next() ** 0.7 * (NOW.getTime() - earliest)
    : NOW.getTime() - rng.next() ** 2 * 21 * DAY;
  end = Math.min(Math.max(end, earliest + steps * HOUR), NOW.getTime());
  const start = Math.max(earliest, end - span);
  const times = timeline(rng, start, end, steps);

  /** Instante en que el tramite ENTRO por ultima vez a ese estado. */
  const at = (state: State): Date | null => {
    const i = path.lastIndexOf(state);
    return i >= 0 ? times[i]! : null;
  };
  /** La PRIMERA vez, que es lo que cuenta para el pago: se cobra antes de salir. */
  const firstAt = (state: State): Date | null => {
    const i = path.indexOf(state);
    return i >= 0 ? times[i]! : null;
  };
  const reached = (state: State): boolean => path.includes(state);
  const pickStaff = (ids: string[]): string | null => (ids.length > 0 ? rng.pick(ids) : null);

  const shipmentId = randomUUID();
  const receivedInMiami = reached(State.RecibidoBodegaMiami);
  // Peso sesgado a lo liviano: la cola de paquetes pesados existe, pero es cola.
  const weightKg = isPackage ? 1 + Math.floor(rng.next() ** 2 * 29) : null;

  // --- 1) Lineas de costo: existen desde que el tramite entra a facturacion ---
  const billingAt = at(State.FacturacionEnProceso);
  const lines: {
    /** Servicio del catalogo del que sale la linea; el flete no sale de ninguno. */
    ref: ServiceRef | undefined;
    label: string;
    source: CostLineSource;
    percentage: number | null;
    amount: number;
    currency: Currency;
  }[] = [];

  const push = (name: string | null, label: string, source: CostLineSource, amount: number, currency: Currency, percentage: number | null = null): void => {
    lines.push({ ref: name ? services.get(name) : undefined, label, source, percentage, amount, currency });
  };

  if (billingAt) {
    if (isPackage) {
      // Flete = peso (entero) x precio por kg de la tarifa del cliente, en USD.
      // Sin casillero no hay tarifa: el paquete sin dueño no llega a facturar.
      const pricePerKg = client?.pricePerKg ?? 0;
      push(null, `Flete ${weightKg} kg`, CostLineSource.Freight, roundMoney(weightKg! * pricePerKg, Currency.USD), Currency.USD);
      push('Manejo en bodega Miami', 'Manejo en bodega Miami', CostLineSource.Service, 3.5, Currency.USD);
      if (rng.chance(0.18)) {
        push('Asesoría de compra por Internet', 'Asesoría de compra por Internet', CostLineSource.Service, roundMoney(8 + rng.next() * 17, Currency.USD), Currency.USD);
      }
      if (rng.chance(0.14)) {
        push('Empaque especial', 'Empaque especial', CostLineSource.Service, 7, Currency.USD);
      }
      // El porcentaje SIEMPRE se calcula sobre las lineas que no son porcentaje.
      const base = percentageBase(
        lines.map((l) => ({ amount: l.amount, currency: l.currency, exchangeRate, source: l.source })),
        Currency.USD,
      );
      push('Permisos de Importación', 'Permisos de Importación', CostLineSource.Percentage, applyPercentage(base, 10, Currency.USD), Currency.USD, 10);
      if (rng.chance(0.2)) {
        push('Seguro de mercancía', 'Seguro de mercancía', CostLineSource.Percentage, applyPercentage(base, 2.5, Currency.USD), Currency.USD, 2.5);
      }
    } else {
      // Transporte y agenciamiento: todo se digita al recibir (valor Manual).
      push('Transporte terrestre', 'Transporte terrestre', CostLineSource.Service, roundMoney(rng.int(38_000, 120_000), Currency.CRC), Currency.CRC);
      push('Almacenaje fiscal', 'Almacenaje fiscal', CostLineSource.Service, roundMoney(rng.int(18_000, 95_000), Currency.CRC), Currency.CRC);
      push('Impuesto de aduana', 'Impuesto de aduana', CostLineSource.Service, roundMoney(rng.int(85_000, 1_400_000), Currency.CRC), Currency.CRC);
      if (type === ShipmentType.Agenciamiento) {
        push('Honorarios de agenciamiento', 'Honorarios de agenciamiento', CostLineSource.Service, roundMoney(rng.int(45_000, 180_000), Currency.CRC), Currency.CRC);
        if (rng.chance(0.4)) {
          push('Inspección Dekra', 'Inspección Dekra', CostLineSource.Service, roundMoney(rng.int(35_000, 90_000), Currency.CRC), Currency.CRC);
        }
      } else {
        // Una linea en dolares: la factura mezcla monedas y cada una lleva la suya.
        push('Desalmacenaje', 'Desalmacenaje', CostLineSource.Service, roundMoney(60 + rng.next() * 240, Currency.USD), Currency.USD);
      }
    }
  }

  // --- 2) Aprobacion: congela el total de la factura en AMBAS monedas ---
  const approvedAt = at(State.EnBodegaPendientePago);
  const totals = lines.length > 0 ? computeTotals(lines.map((l) => ({ amount: l.amount, currency: l.currency, exchangeRate }))) : null;
  const approved = approvedAt !== null && totals !== null;

  const cargo = rng.pick(CARGO_ITEMS);
  const delivered = finalState === State.Entregado;
  const discarded = unassigned && rng.chance(0.25);
  /**
   * Replicacion de la prealerta ante el proveedor: el paquete que ya llego a
   * Miami esta sincronizado por definicion; del resto, unos pocos fallaron y la
   * reconciliacion los reintentara. Solo aplica a Paqueteria.
   */
  const prealert = !isPackage
    ? null
    : receivedInMiami
      ? HelgaSyncStatus.Synced
      : rng.chance(0.12)
        ? HelgaSyncStatus.Failed
        : HelgaSyncStatus.Pending;

  out.shipmentRows.push({
    id: shipmentId,
    code,
    clientId: client?.id ?? null,
    shipmentType: type,
    state: finalState,
    // El prefijo BLK es la marca de este seed: es lo que hace que `--reset`
    // pueda borrar tambien los tramites sin casillero.
    tracking: isPackage
      ? `${TRACKING_PREFIX}1Z${seq.padStart(9, '0')}`
      : type === ShipmentType.Aereo
        ? `${TRACKING_PREFIX}045${seq.padStart(9, '0')}`
        : `${TRACKING_PREFIX}MSCU${seq.padStart(8, '0')}`,
    description: isPackage ? `${rng.pick(PACKAGE_ITEMS)} (${rng.int(1, 4)} unid.)` : cargo,
    store: isPackage ? rng.pick(STORES) : null,
    carrier: isPackage ? rng.pick(CARRIERS) : null,
    // Formato de la etiqueta real; es lo que se escanea en la mesa de bodega.
    hawb: isPackage && receivedInMiami ? `LES${String(48_000_000 + n)}` : null,
    weightKg,
    lengthCm: isPackage && receivedInMiami ? rng.int(15, 90) : null,
    widthCm: isPackage && receivedInMiami ? rng.int(12, 70) : null,
    heightCm: isPackage && receivedInMiami ? rng.int(8, 60) : null,
    // Peso, no dinero: se redondea a un decimal, no con las reglas de moneda.
    volumetricWeightKg: isPackage && receivedInMiami ? Math.round((rng.next() * 24 + 0.5) * 10) / 10 : null,
    declaredValueUsd: isPackage ? roundMoney(20 + rng.next() ** 1.8 * 900, Currency.USD) : null,
    insuredValueUsd: isPackage && rng.chance(0.15) ? roundMoney(80 + rng.next() * 700, Currency.USD) : null,
    tariffPosition: isPackage && rng.chance(0.3) ? `8517.62.00.${String(rng.int(10, 99))}` : null,
    retain: isPackage ? rng.chance(0.04) : null,
    documentFileKey: isPackage && rng.chance(0.35) ? `documents/bulk-${code}.pdf` : null,
    warehouse: isPackage ? null : rng.pick(WAREHOUSES),
    dua: isPackage ? null : `DUA-2026-${String(rng.int(100_000, 999_999))}`,
    billingNotes: !isPackage && rng.chance(0.3) ? 'Cliente solicita factura separada por flete y aranceles.' : null,
    electronicInvoiceNumber: delivered && rng.chance(0.8) ? `FE-${String(1_000_000 + n)}` : null,
    invoiceTotalUsd: approved ? totals!.usd : null,
    invoiceTotalCrc: approved ? totals!.crc : null,
    // Snapshot de la tarifa de flete, igual que `costsRepo.freezeInvoice`: solo
    // Paqueteria, y solo cuando la factura quedo congelada.
    freightRateUsdPerLb: approved && isPackage ? DEFAULT_FREIGHT_RATE : null,
    costsApprovedAt: approved ? approvedAt : null,
    costsApprovedBy: approved ? pickStaff(staff.financeIds) : null,
    helgaPrealertStatus: prealert,
    helgaPrealertId: prealert === HelgaSyncStatus.Synced ? String(700_000 + n) : null,
    helgaPrealertAttempts: prealert === HelgaSyncStatus.Synced ? 1 : prealert === HelgaSyncStatus.Failed ? 2 : 0,
    helgaPrealertError:
      prealert === HelgaSyncStatus.Failed
        ? 'El proveedor no aceptó la prealerta: el casillero aún no está enlazado.'
        : null,
    discardedAt: discarded ? times[times.length - 1]! : null,
    discardedBy: discarded ? pickStaff(staff.opsIds) : null,
    discardReason: discarded ? 'Bulto sin identificar tras 30 días en bodega.' : null,
    // La prealerta de paqueteria la hace el cliente; el resto lo abre el staff.
    // El paquete sin dueño no lo prealerto nadie: entro por la mesa de bodega.
    createdBy: isPackage ? null : pickStaff(rng.chance(0.5) ? staff.agentIds : staff.adminIds),
    createdAt: times[0]!,
    updatedAt: times[times.length - 1]!,
  });

  // --- 3) Historial de estados (append-only, un evento por paso) ---
  path.forEach((state, i) => {
    out.eventRows.push({
      shipmentId,
      state,
      note:
        state === State.DevueltoBodega
          ? 'El cliente no se encontraba en la dirección. Se reprograma la entrega.'
          : i === 0
            ? 'Trámite creado.'
            : null,
      createdBy:
        i === 0
          ? isPackage
            ? null
            : pickStaff(staff.agentIds)
          : state === State.EnRutaEntrega || state === State.Entregado || state === State.DevueltoBodega
            ? pickStaff(staff.courierIds)
            : state === State.FacturacionEnProceso
              ? pickStaff(staff.financeIds)
              : pickStaff(staff.opsIds),
      createdAt: times[i]!,
    });
  });

  // --- 4) Lineas de costo (cada una con su moneda y su tasa: M2 + M5) ---
  for (const line of lines) {
    out.costRows.push({
      shipmentId,
      costServiceId: line.ref?.id ?? null,
      label: line.label,
      // Snapshot del catalogo, igual que en `costsService.save`. El flete no
      // sale de ningun servicio: `categoryForLine` le impone CostCategory.Flete.
      category: categoryForLine(line.source, line.ref?.category),
      electronicInvoiceCode: line.ref?.electronicInvoiceCode ?? null,
      source: line.source,
      percentage: line.percentage,
      amount: line.amount,
      currency: line.currency,
      exchangeRate,
      createdBy: pickStaff(staff.financeIds),
      createdAt: billingAt!,
    });
  }

  // --- 5) Pagos. El monto a cubrir es el total congelado en colones ---
  if (approved) {
    const dueCrc = totals!.crc;
    const settledRequired = reached(State.EnRutaEntrega);
    const paidAt = firstAt(State.EnRutaEntrega) ?? new Date(Math.min(NOW.getTime(), approvedAt!.getTime() + DAY));
    const usdFor = (crc: number): number => usdToCoverCrc(crc, exchangeRate);
    const account = (): BankAccount => rng.pick(bankAccountsFor(type));

    const deposit = (amount: number, status: PaymentStatus, note: string | null = null): typeof payments.$inferInsert => ({
      shipmentId,
      method: PaymentMethod.DepositoBancario,
      status,
      amount,
      currency: Currency.CRC,
      exchangeRate,
      // Una cuenta de las que ESE tramite admite (Paqueteria solo las de
      // dolares): la misma regla que el formulario del cliente.
      bankAccount: account(),
      receiptNumber: String(1_000_000 + n),
      depositedAt: paidAt,
      receiptFileKey: `receipts/bulk-${code}.pdf`,
      note,
      createdBy: null,
      confirmedBy: status === PaymentStatus.Pendiente ? null : pickStaff(staff.financeIds),
      confirmedAt: status === PaymentStatus.Pendiente ? null : paidAt,
      createdAt: paidAt,
    });

    const card = (amountUsd: number, attempt: number): typeof payments.$inferInsert => ({
      shipmentId,
      method: PaymentMethod.Tarjeta,
      status: PaymentStatus.Confirmado,
      amount: amountUsd,
      currency: Currency.USD,
      exchangeRate,
      bankAccount: null,
      receiptNumber: null,
      depositedAt: null,
      receiptFileKey: null,
      gatewayReference: `onvo_pi_bulk_${seq}_${attempt}`,
      note: null,
      createdBy: null,
      confirmedBy: null,
      confirmedAt: paidAt,
      createdAt: paidAt,
    });

    const mine: (typeof payments.$inferInsert)[] = [];
    if (settledRequired) {
      // Salio a ruta: la factura esta cubierta, con la forma de pago que sea.
      const roll = rng.next();
      if (roll < 0.5) mine.push(deposit(dueCrc, PaymentStatus.Confirmado));
      else if (roll < 0.88) mine.push(card(usdFor(dueCrc), 0));
      else {
        const first = roundMoney(dueCrc * 0.4, Currency.CRC);
        mine.push(deposit(first, PaymentStatus.Confirmado, 'Primer abono.'));
        mine.push(card(usdFor(dueCrc - first), 1));
      }
    } else if (finalState === State.EnBodegaPendientePago) {
      // La cola de cobro: sin abonar, esperando confirmacion, rechazado o a medias.
      const roll = rng.next();
      if (roll < 0.4) {
        /* sin pago todavia */
      } else if (roll < 0.68) mine.push(deposit(dueCrc, PaymentStatus.Pendiente));
      else if (roll < 0.78) mine.push(deposit(dueCrc, PaymentStatus.Rechazado, 'El comprobante no corresponde al monto facturado.'));
      else mine.push(deposit(roundMoney(dueCrc * (0.2 + rng.next() * 0.5), Currency.CRC), PaymentStatus.Confirmado, 'Abono parcial.'));
    }

    // Invariante: si el tramite salio a ruta, el pago DEBE estar cubierto
    // (Condition.RequiresConfirmedPayment). Se verifica con la misma funcion
    // que usa la API, no con una cuenta aparte.
    if (settledRequired) {
      const settleable = mine.map((p) => ({
        amount: p.amount,
        currency: p.currency,
        exchangeRate: p.exchangeRate,
        status: p.status ?? PaymentStatus.Pendiente,
      }));
      if (!isSettled(settleable, dueCrc)) {
        throw new Error(`[seed-bulk] ${code} salió a ruta sin pago suficiente.`);
      }
    }
    out.paymentRows.push(...mine);
  } else if (reached(State.EnRutaEntrega)) {
    // Sin factura congelada no se puede salir a ruta: si esto pasa, el generador
    // esta produciendo datos que la API rechazaria.
    throw new Error(`[seed-bulk] ${code} salió a ruta sin factura aprobada.`);
  }

  // --- 6) Intentos de entrega (uno por visita del mensajero) ---
  const attempts: DeliveryOutcome[] = retried
    ? [DeliveryOutcome.DevueltoBodega, DeliveryOutcome.Entregado]
    : finalState === State.Entregado
      ? [DeliveryOutcome.Entregado]
      : finalState === State.DevueltoBodega
        ? [DeliveryOutcome.DevueltoBodega]
        : [];
  attempts.forEach((outcome, i) => {
    const state = outcome === DeliveryOutcome.Entregado ? State.Entregado : State.DevueltoBodega;
    // Con reintento hay dos visitas y dos instantes: el primero es el fallido.
    const idx = retried && i === 0 ? path.indexOf(State.DevueltoBodega) : path.lastIndexOf(state);
    out.attemptRows.push({
      shipmentId,
      outcome,
      photoFileKey: outcome === DeliveryOutcome.Entregado ? `deliveries/bulk-${code}.jpg` : null,
      note:
        outcome === DeliveryOutcome.DevueltoBodega
          ? 'Nadie atendió en la dirección. Se deja aviso y se reprograma.'
          : null,
      courierId: pickStaff(staff.courierIds),
      createdAt: idx >= 0 ? times[idx]! : times[times.length - 1]!,
    });
  });
}

db.transaction((tx) => seed(tx))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-bulk] error:', err);
    process.exit(1);
  });
