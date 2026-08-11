/**
 * Seed de datos DUMMY para desarrollo y demos: llena el sistema de punta a punta
 * (staff, casilleros, catalogo de servicios, rutas, anuncios, tramites de los 5
 * tipos con su historial completo, costos, pagos e intentos de entrega).
 *
 * NO es el seed de arranque. `seed.ts` siembra lo minimo real (el primer admin y
 * las tarifas de cliente); esto siembra lo FALSO que hace falta para ver el
 * producto lleno. Por eso vive aparte y todo lo que crea es reconocible:
 *   - los usuarios usan el dominio `@demo.hsglobal.ltd`;
 *   - los servicios, anuncios y rutas que crea estan listados aqui.
 * Eso es lo que permite que `--reset` borre SOLO lo sembrado por este archivo y
 * jamas toque datos reales.
 *
 * Dos invariantes que el seed se verifica a si mismo (y aborta si fallan):
 *   1. Todo historial de estados se valida contra la maquina de @courier/shared
 *      (`canTransition`): ningun tramite queda con una secuencia imposible.
 *   2. Todo tramite en un estado que exige pago confirmado cumple `isSettled`.
 * Asi el dato de demo nunca contradice al dominio.
 *
 * Reglas de dinero (money-rules): cada linea de costo y cada pago se guarda con
 * su moneda explicita (M2) y su tasa de cambio del momento (M5); los importes
 * derivados pasan por `roundMoney`/`convertMoney`/`computeTotals` (M4).
 *
 * Uso: pnpm --filter @courier/api db:seed:demo
 *      pnpm --filter @courier/api db:seed:demo -- --reset   (borra y resiembra)
 *   Variable opcional: SEED_DEMO_PASSWORD (por defecto `Demo1234!`).
 *
 * Requiere haber corrido antes `db:seed` (necesita las tarifas de cliente).
 */
import { hash } from '@node-rs/argon2';
import { eq, inArray, like, sql } from 'drizzle-orm';
import {
  AnnouncementType,
  BankAccount,
  CARRIERS,
  ClientReviewStatus,
  CostCategory,
  CostLineSource,
  categoryForLine,
  Currency,
  DeliveryOutcome,
  Flow,
  HelgaSyncStatus,
  PaymentMethod,
  PaymentStatus,
  Principal,
  Role,
  SHIPMENT_TYPE_VALUES,
  STATE_VALUES,
  STORES,
  ServiceKind,
  ServiceValueType,
  ShipmentType,
  State,
  UserStatus,
  applyPercentage,
  bankAccountsFor,
  canTransition,
  computeTotals,
  convertMoney,
  findDistrict,
  flowForType,
  formatShipmentCode,
  isSettled,
  isValidLocation,
  percentageBase,
  roundMoney,
  statesOf,
} from '@courier/shared';
import { db } from './core/db';
import { announcements } from './modules/announcements/announcement.schema';
import { clients, users } from './modules/auth/auth.schema';
import { costServices } from './modules/cost-services/cost-service.schema';
import { shipmentCosts } from './modules/costs/shipment-cost.schema';
import { deliveryAttempts } from './modules/deliveries/deliveries.schema';
import { payments } from './modules/payments/payments.schema';
import { districtRoutes } from './modules/routes/district-route.schema';
import { shipmentEvents, shipments } from './modules/shipments/shipments.schema';
import {
  SETTINGS_ROW_ID,
  appSettings,
  exchangeRateHistory,
  freightRateHistory,
} from './modules/settings/settings.schema';
import { clientRates } from './modules/tariffs/tariffs.schema';

/**
 * Tasa que fija la demo si el sistema no tiene ninguna (colones por 1 USD). Es
 * la que se congela en TODO el dinero sembrado: en produccion la tasa es un
 * valor unico que fija quien tiene `exchange_rate.write`, asi que sembrar una
 * distinta por tramite mostraria un sistema que no existe. Si ya habia una tasa
 * vigente, manda esa y este valor no se usa.
 */
const DEMO_EXCHANGE_RATE = 512.75;

/** Marca del registro de historial que siembra este archivo (lo borra `--reset`). */
const DEMO_RATE_NOTE = 'Tasa inicial de la demo.';

/**
 * Tarifa de transporte internacional de la demo, en USD por libra. Es la del
 * mapeo de campos validado con el negocio ("× 3.66"), para que el reporte FULL
 * de Paqueteria de las mismas cifras que la hoja con la que se cuadra.
 */
const DEMO_FREIGHT_RATE = 3.66;
const DEMO_FREIGHT_NOTE = 'Tarifa inicial de la demo.';

/** Dominio de correo que marca a un usuario como sembrado por esta demo. */
const DEMO_DOMAIN = 'demo.hsglobal.ltd';
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo1234!';

const DAY = 86_400_000;
const NOW = new Date();
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * DAY);
const inDays = (d: number): Date => new Date(NOW.getTime() + d * DAY);
/** `date` de Postgres se persiste como texto YYYY-MM-DD. */
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const email = (handle: string): string => `${handle}@${DEMO_DOMAIN}`;

/**
 * Cuenta bancaria de un deposito de demo: una de las que ese tipo de tramite
 * admite, alternando por indice para que la demo no muestre siempre el mismo
 * banco. Sale de `bankAccountsFor` y no de una lista propia para que los datos
 * de demo cumplan la misma regla que el formulario del cliente.
 */
const pickAccount = (type: ShipmentType, i: number): BankAccount => {
  const options = bankAccountsFor(type);
  return options[i % options.length]!;
};

// ---------------------------------------------------------------------------
// 1. Catalogo de datos falsos (todo lo que este seed crea sale de estas listas)
// ---------------------------------------------------------------------------

interface StaffSpec {
  handle: string;
  name: string;
  role: Role;
  phone: string;
  status?: UserStatus;
}

/** Un usuario por rol de staff, mas un segundo mensajero y uno inactivo. */
const STAFF: readonly StaffSpec[] = [
  { handle: 'jose.alfaro', name: 'José Alfaro', role: Role.Admin, phone: '88110022' },
  { handle: 'ana.soto', name: 'Ana Soto', role: Role.ServicioCliente, phone: '87450199' },
  { handle: 'carlos.mena', name: 'Carlos Mena', role: Role.Operativo, phone: '83920477' },
  { handle: 'diana.rojas', name: 'Diana Rojas', role: Role.Financiero, phone: '86031588' },
  { handle: 'luis.vargas', name: 'Luis Vargas', role: Role.Mensajeria, phone: '89660234' },
  { handle: 'maria.chaves', name: 'María Chaves', role: Role.Mensajeria, phone: '84770911' },
  {
    handle: 'pedro.ramirez',
    name: 'Pedro Ramírez',
    role: Role.Operativo,
    phone: '85120366',
    status: UserStatus.Inactivo,
  },
];

interface ClientSpec {
  handle: string;
  name: string;
  idNumber: string;
  phone: string;
  /** Codigo oficial de 5 digitos; provincia y canton se derivan de el. */
  districtCode: string;
  addressLine: string;
  /** Nombre de la tarifa de cliente; debe existir en `client_rates`. */
  rate: string;
  reviewStatus: ClientReviewStatus;
  helga: HelgaSyncStatus;
  /** Techo de credito: monto + moneda explicita (M2). null = sin limite. */
  creditLimit?: { amount: number; currency: Currency };
  memberSinceDays: number;
  verified?: boolean;
  status?: UserStatus;
}

/** 12 casilleros repartidos por las 7 provincias, con todas las combinaciones. */
const CLIENTS: readonly ClientSpec[] = [
  {
    handle: 'laura.jimenez',
    name: 'Laura Jiménez Mora',
    idNumber: '110450678',
    phone: '83450192',
    districtCode: '10101',
    addressLine: 'Barrio Escalante, 100 m norte de la iglesia Santa Teresita, casa color verde',
    rate: 'Básica',
    reviewStatus: ClientReviewStatus.Revisado,
    helga: HelgaSyncStatus.Synced,
    creditLimit: { amount: 500, currency: Currency.USD },
    memberSinceDays: 420,
    verified: true,
  },
  {
    handle: 'mario.solano',
    name: 'Mario Solano Vega',
    idNumber: '204880311',
    phone: '87120044',
    districtCode: '10801',
    addressLine: 'Guadalupe centro, Residencial Los Cipreses, apartamento 3B',
    rate: 'Plus',
    reviewStatus: ClientReviewStatus.Revisado,
    helga: HelgaSyncStatus.Synced,
    creditLimit: { amount: 250000, currency: Currency.CRC },
    memberSinceDays: 365,
    verified: true,
  },
  {
    handle: 'silvia.arias',
    name: 'Silvia Arias Campos',
    idNumber: '303910255',
    phone: '86340781',
    districtCode: '30101',
    addressLine: 'Cartago centro, del Banco Nacional 200 m sur y 50 m este',
    rate: 'Pro',
    reviewStatus: ClientReviewStatus.Revisado,
    helga: HelgaSyncStatus.Synced,
    memberSinceDays: 300,
    verified: true,
  },
  {
    handle: 'randall.quiros',
    name: 'Randall Quirós Ureña',
    idNumber: '112670933',
    phone: '88900215',
    districtCode: '40101',
    addressLine: 'Heredia centro, frente al parque Nicolás Ulloa, edificio Torre Real piso 4',
    rate: 'Gold',
    reviewStatus: ClientReviewStatus.Revisado,
    helga: HelgaSyncStatus.Synced,
    creditLimit: { amount: 1200, currency: Currency.USD },
    memberSinceDays: 280,
    verified: true,
  },
  {
    handle: 'karla.venegas',
    name: 'Karla Venegas Pérez',
    idNumber: '205430188',
    phone: '84010567',
    districtCode: '20101',
    addressLine: 'Alajuela centro, Urbanización El Roble, casa 27',
    rate: 'Básica',
    reviewStatus: ClientReviewStatus.Nuevo,
    helga: HelgaSyncStatus.Pending,
    memberSinceDays: 40,
    verified: true,
  },
  {
    handle: 'esteban.rojas',
    name: 'Esteban Rojas Sandí',
    idNumber: '702340591',
    phone: '85670433',
    districtCode: '70101',
    addressLine: 'Limón centro, Barrio Roosevelt, contiguo a la escuela',
    rate: 'Básica',
    reviewStatus: ClientReviewStatus.Nuevo,
    helga: HelgaSyncStatus.Failed,
    memberSinceDays: 25,
    verified: true,
  },
  {
    handle: 'natalia.brenes',
    name: 'Natalia Brenes Umaña',
    idNumber: '503780122',
    phone: '89210655',
    districtCode: '50101',
    addressLine: 'Liberia, Barrio La Victoria, 300 m este del estadio Edgardo Baltodano',
    rate: 'Black',
    reviewStatus: ClientReviewStatus.Revisado,
    helga: HelgaSyncStatus.Synced,
    creditLimit: { amount: 800000, currency: Currency.CRC },
    memberSinceDays: 520,
    verified: true,
  },
  {
    handle: 'gerardo.mora',
    name: 'Gerardo Mora Castillo',
    idNumber: '601290744',
    phone: '83380122',
    districtCode: '60101',
    addressLine: 'Puntarenas centro, Paseo de los Turistas, casa esquinera portón azul',
    rate: 'Plus',
    reviewStatus: ClientReviewStatus.Revisado,
    helga: HelgaSyncStatus.Synced,
    memberSinceDays: 190,
    verified: true,
  },
  {
    handle: 'andrea.picado',
    name: 'Andrea Picado Herrera',
    idNumber: '115980377',
    phone: '87880490',
    districtCode: '30301',
    addressLine: 'Tres Ríos, Condominio Vista Verde, torre 2 apartamento 501',
    rate: 'Platinum',
    reviewStatus: ClientReviewStatus.Revisado,
    helga: HelgaSyncStatus.Synced,
    creditLimit: { amount: 2500, currency: Currency.USD },
    memberSinceDays: 610,
    verified: true,
  },
  {
    handle: 'oscar.fallas',
    name: 'Óscar Fallas Godínez',
    idNumber: '207110488',
    phone: '86450277',
    districtCode: '21001',
    addressLine: 'Ciudad Quesada, 400 m norte del hospital San Carlos, local comercial',
    rate: 'Pro',
    reviewStatus: ClientReviewStatus.Revisado,
    helga: HelgaSyncStatus.Synced,
    memberSinceDays: 150,
    verified: true,
  },
  {
    handle: 'vanessa.leiva',
    name: 'Vanessa Leiva Corrales',
    idNumber: '119020866',
    phone: '84330719',
    districtCode: '40301',
    addressLine: 'Santo Domingo de Heredia, del cementerio 150 m oeste, casa blanca',
    rate: 'Básica',
    // Recien registrada: aun no verifico el correo, por eso no puede entrar.
    reviewStatus: ClientReviewStatus.Nuevo,
    helga: HelgaSyncStatus.Pending,
    memberSinceDays: 6,
    verified: false,
  },
  {
    handle: 'jorge.badilla',
    name: 'Jorge Badilla Cordero',
    idNumber: '303450199',
    phone: '88070344',
    districtCode: '20301',
    addressLine: 'Grecia centro, 200 m sur de la iglesia de metal, casa portón café',
    rate: 'Básica',
    reviewStatus: ClientReviewStatus.Revisado,
    helga: HelgaSyncStatus.Synced,
    memberSinceDays: 95,
    verified: true,
    // Cuenta desactivada por el admin: sirve para probar el bloqueo de acceso.
    status: UserStatus.Inactivo,
  },
];

interface ServiceSpec {
  name: string;
  kind: ServiceKind;
  /** De quien es el dinero: decide si el concepto es costo o margen en el reporte. */
  category: CostCategory;
  /** COD SIS FE del concepto; lo imprime la proforma. */
  electronicInvoiceCode: string;
  valueType: ServiceValueType;
  defaultValue: number | null;
  /** Solo cuando valueType = Fixed (es dinero). Regla M2. */
  currency: Currency | null;
  enabled?: boolean;
}

/**
 * Catalogo de servicios de costo. Transporte y agenciamiento solo admite valor
 * Manual (`allowedValueTypes`); Paqueteria admite los tres y solo USD (M6).
 */
/**
 * `category` separa lo que HS Global solo TRASLADA (impuestos, almacen fiscal,
 * naviera) de lo que son honorarios propios. Sin ese corte, COSTOS ASOCIADOS del
 * reporte de Agenciamiento sumaria la factura entera y el PROFIT saldria en cero
 * en todas las filas de la demo. `electronicInvoiceCode` es el COD SIS FE que
 * imprime la proforma.
 */
const SERVICES: readonly ServiceSpec[] = [
  { name: 'Impuesto de aduana', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Impuestos, electronicInvoiceCode: '44', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Almacenaje fiscal', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Otros, electronicInvoiceCode: '61', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Transporte terrestre', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Otros, electronicInvoiceCode: '25', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Honorarios de agenciamiento', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Propio, electronicInvoiceCode: '10', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Inspección Dekra', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Otros, electronicInvoiceCode: '73', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Desalmacenaje', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Propio, electronicInvoiceCode: '11', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Permisos de Importación', kind: ServiceKind.Paqueteria, category: CostCategory.Otros, electronicInvoiceCode: '97', valueType: ServiceValueType.Percentage, defaultValue: 10, currency: null },
  { name: 'Seguro de mercancía', kind: ServiceKind.Paqueteria, category: CostCategory.Otros, electronicInvoiceCode: '52', valueType: ServiceValueType.Percentage, defaultValue: 2.5, currency: null },
  { name: 'Manejo en bodega Miami', kind: ServiceKind.Paqueteria, category: CostCategory.Propio, electronicInvoiceCode: '31', valueType: ServiceValueType.Fixed, defaultValue: 3.5, currency: Currency.USD },
  { name: 'Empaque especial', kind: ServiceKind.Paqueteria, category: CostCategory.Propio, electronicInvoiceCode: '32', valueType: ServiceValueType.Fixed, defaultValue: 7, currency: Currency.USD },
  { name: 'Asesoría de compra por Internet', kind: ServiceKind.Paqueteria, category: CostCategory.Propio, electronicInvoiceCode: '33', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Sobrecargo de combustible', kind: ServiceKind.Paqueteria, category: CostCategory.Otros, electronicInvoiceCode: '26', valueType: ServiceValueType.Fixed, defaultValue: 1.75, currency: Currency.USD, enabled: false },
];

/**
 * Rutas operativas: cada grupo es una ruta y lista los distritos que cubre. Se
 * incluyen los distritos de todos los casilleros de demo para que la pantalla de
 * entregas tenga ruta asignada en cada direccion.
 */
const ROUTES: readonly { routeNumber: number; districts: readonly string[] }[] = [
  { routeNumber: 1, districts: ['10101', '10103', '10801'] },
  { routeNumber: 2, districts: ['10301', '30301'] },
  { routeNumber: 3, districts: ['30101'] },
  { routeNumber: 4, districts: ['40101', '40301'] },
  { routeNumber: 5, districts: ['20101', '20301'] },
  { routeNumber: 6, districts: ['21001'] },
  { routeNumber: 7, districts: ['50101', '50201'] },
  { routeNumber: 8, districts: ['60101', '60801'] },
  { routeNumber: 9, districts: ['70101', '70201'] },
];

interface AnnouncementSpec {
  title: string;
  message: string;
  type: AnnouncementType;
  startsAt: Date;
  endsAt: Date;
  enabled: boolean;
}

/** Uno por estado derivado: activo, programado, vencido e inactivo. */
const ANNOUNCEMENTS: readonly AnnouncementSpec[] = [
  {
    title: 'Nuevo horario de entregas',
    message: 'A partir de este mes entregamos de lunes a sábado, de 8:00 a. m. a 6:00 p. m. en el Gran Área Metropolitana.',
    type: AnnouncementType.Informativo,
    startsAt: daysAgo(10),
    endsAt: inDays(20),
    enabled: true,
  },
  {
    title: 'Retraso en vuelos desde Miami',
    message: 'Los envíos aéreos de esta semana salen con 48 horas de retraso por congestión en el aeropuerto de origen. Gracias por la paciencia.',
    type: AnnouncementType.Advertencia,
    startsAt: daysAgo(3),
    endsAt: inDays(7),
    enabled: true,
  },
  {
    title: 'Cierre de aduanas por feriado',
    message: 'Aduanas permanecerá cerrada el próximo lunes. Los trámites en proceso se reanudan el martes a primera hora.',
    type: AnnouncementType.Critico,
    startsAt: daysAgo(1),
    endsAt: inDays(4),
    enabled: true,
  },
  {
    title: 'Mantenimiento del portal',
    message: 'El portal estará fuera de servicio por mantenimiento programado la próxima semana, de 11:00 p. m. a 2:00 a. m.',
    type: AnnouncementType.Advertencia,
    startsAt: inDays(6),
    endsAt: inDays(9),
    enabled: true,
  },
  {
    title: 'Promoción de temporada finalizada',
    message: 'La promoción de tarifa Plus por tres meses terminó. Consulta las tarifas vigentes en tu perfil.',
    type: AnnouncementType.Informativo,
    startsAt: daysAgo(60),
    endsAt: daysAgo(20),
    enabled: true,
  },
  {
    title: 'Borrador: cambio de bodega',
    message: 'Texto pendiente de aprobación sobre el traslado de la bodega de consolidación en Miami.',
    type: AnnouncementType.Informativo,
    startsAt: daysAgo(5),
    endsAt: inDays(30),
    enabled: false,
  },
];

/** Compras de Paqueteria: descripcion, tienda y transportista del catalogo cerrado. */
const PACKAGE_ITEMS: readonly { description: string; store: string; carrier: string }[] = [
  { description: 'Audífonos inalámbricos y estuche de carga', store: STORES[0], carrier: CARRIERS[0] },
  { description: 'Dos pares de tenis deportivos talla 9', store: STORES[5], carrier: CARRIERS[3] },
  { description: 'Ropa de bebé, lote de 12 piezas', store: STORES[2], carrier: CARRIERS[1] },
  { description: 'Cafetera de goteo programable', store: STORES[6], carrier: CARRIERS[2] },
  { description: 'Repuestos de bicicleta: cadena, frenos y pedales', store: STORES[1], carrier: CARRIERS[4] },
  { description: 'Set de maquillaje y cremas faciales', store: STORES[3], carrier: CARRIERS[5] },
  { description: 'Pulsera de plata y dije', store: STORES[7], carrier: CARRIERS[1] },
  { description: 'Teclado mecánico y mouse gamer', store: STORES[4], carrier: CARRIERS[6] },
  { description: 'Vitaminas y suplementos, 3 frascos', store: STORES[0], carrier: CARRIERS[0] },
  { description: 'Cortinas de baño y juego de toallas', store: STORES[10], carrier: CARRIERS[2] },
  { description: 'Lencería y pijamas', store: STORES[8], carrier: CARRIERS[3] },
  { description: 'Herramientas: taladro inalámbrico con brocas', store: STORES[6], carrier: CARRIERS[4] },
];

/** Cargas de Transporte y Agenciamiento: descripcion, bodega, DUA y notas. */
const CARGO_ITEMS: readonly { description: string; warehouse: string; dua: string; notes: string }[] = [
  { description: 'Contenedor 40 pies con repuestos automotrices', warehouse: 'Bodega Fiscal Alajuela 7', dua: 'DUA-2026-004512', notes: 'Cliente solicita factura separada por flete y aranceles.' },
  { description: 'Maquinaria industrial: prensa hidráulica', warehouse: 'Bodega Fiscal Santamaría 2', dua: 'DUA-2026-004780', notes: 'Requiere permiso del Ministerio de Salud.' },
  { description: 'Lote de textiles para confección', warehouse: 'Bodega Fiscal Caldera 4', dua: 'DUA-2026-005033', notes: 'Exonerado parcial por tratado comercial.' },
  { description: 'Equipo médico: dos ultrasonidos portátiles', warehouse: 'Bodega Fiscal Moín 1', dua: 'DUA-2026-005190', notes: 'Trámite prioritario, cliente corporativo.' },
  { description: 'Insumos agrícolas: fertilizantes en sacos', warehouse: 'Bodega Fiscal Alajuela 7', dua: 'DUA-2026-005264', notes: 'Inspección fitosanitaria obligatoria.' },
  { description: 'Mobiliario de oficina, 3 tarimas', warehouse: 'Bodega Fiscal Santamaría 2', dua: 'DUA-2026-005401', notes: 'Entrega coordinada con el cliente para descarga.' },
  { description: 'Paneles solares y estructuras de montaje', warehouse: 'Bodega Fiscal Caldera 4', dua: 'DUA-2026-005588', notes: 'Carga sobredimensionada, requiere plataforma.' },
  { description: 'Repuestos electrónicos y tarjetas de control', warehouse: 'Bodega Fiscal Moín 1', dua: 'DUA-2026-005712', notes: 'Valor declarado alto, seguro ampliado.' },
];

// ---------------------------------------------------------------------------
// 2. Helpers de dominio
// ---------------------------------------------------------------------------

/** Provincia y canton salen del codigo del distrito (1 + 3 + 5 digitos). */
function locationOf(districtCode: string): { provinceCode: string; cantonCode: string; districtCode: string } {
  const provinceCode = districtCode.slice(0, 1);
  const cantonCode = districtCode.slice(0, 3);
  if (!isValidLocation(provinceCode, cantonCode, districtCode)) {
    throw new Error(`[seed-demo] Distrito inválido en los datos de demo: ${districtCode}`);
  }
  return { provinceCode, cantonCode, districtCode };
}

/** Valida el historial contra la maquina de estados; aborta si es imposible. */
function assertPath(flow: Flow, path: readonly State[]): void {
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1]!;
    const to = path[i]!;
    if (!canTransition(flow, from, to)) {
      throw new Error(`[seed-demo] Transición inválida en ${flow}: ${from} -> ${to}`);
    }
  }
}

/**
 * Historial hasta un estado: la ruta principal del flow recortada. `Devuelto a
 * bodega` no esta en la linea (es una arista extra desde En ruta de entrega),
 * asi que se arma aparte.
 */
function pathTo(flow: Flow, target: State): State[] {
  const states = statesOf(flow);
  const path =
    target === State.DevueltoBodega
      ? [...states.slice(0, states.indexOf(State.EnRutaEntrega) + 1), State.DevueltoBodega]
      : states.slice(0, states.indexOf(target) + 1);
  assertPath(flow, path);
  return path;
}

/** Instantes de cada evento del historial, repartidos entre `startDays` y hoy. */
function timeline(startDays: number, steps: number): Date[] {
  const start = NOW.getTime() - startDays * DAY;
  const span = startDays * 0.85 * DAY;
  if (steps === 1) return [new Date(start)];
  return Array.from({ length: steps }, (_, i) => new Date(start + (span * i) / (steps - 1)));
}

// ---------------------------------------------------------------------------
// 3. Escenarios de tramites (cobertura: los 5 tipos y TODOS los estados)
// ---------------------------------------------------------------------------

/** Como quedo el cobro del tramite. Determina que filas de `payments` se crean. */
type PaymentPlan = 'none' | 'pending' | 'rejected' | 'partial' | 'full-deposit' | 'full-card' | 'split';

interface Scenario {
  type: ShipmentType;
  path: State[];
  clientIdx: number;
  startDays: number;
  payment: PaymentPlan;
  /** Intentos de entrega a registrar, en orden. */
  attempts: DeliveryOutcome[];
}

/** Plan de cobro por defecto segun el estado final; se rota para variar la demo. */
const UNPAID_PLANS: readonly PaymentPlan[] = ['none', 'pending', 'rejected', 'partial'];
const PAID_PLANS: readonly PaymentPlan[] = ['full-deposit', 'full-card', 'split'];

function buildScenarios(): Scenario[] {
  const out: Scenario[] = [];
  let n = 0;

  const add = (type: ShipmentType, path: State[], attempts: DeliveryOutcome[] = []): void => {
    const flow = flowForType(type);
    assertPath(flow, path);
    const last = path[path.length - 1]!;
    const paid = last === State.EnRutaEntrega || last === State.Entregado || last === State.DevueltoBodega;
    const payment: PaymentPlan = paid
      ? PAID_PLANS[n % PAID_PLANS.length]!
      : last === State.EnBodegaPendientePago
        ? UNPAID_PLANS[n % UNPAID_PLANS.length]!
        : 'none';
    out.push({
      type,
      path,
      clientIdx: n % CLIENTS.length,
      // Cuanto mas avanzado el tramite, mas atras arranca su historia.
      startDays: 7 + path.length * 6 + (n % 5) * 3,
      payment,
      attempts,
    });
    n++;
  };

  // --- Paqueteria: un tramite en cada uno de sus 10 estados ---
  for (const state of statesOf(Flow.Paqueteria)) {
    const path = pathTo(Flow.Paqueteria, state);
    const attempts =
      state === State.Entregado
        ? [DeliveryOutcome.Entregado]
        : state === State.DevueltoBodega
          ? [DeliveryOutcome.DevueltoBodega]
          : [];
    add(ShipmentType.Paqueteria, path, attempts);
  }

  // Tres mas esperando pago, para ver las cuatro situaciones de cobro juntas.
  for (let i = 0; i < 3; i++) {
    add(ShipmentType.Paqueteria, pathTo(Flow.Paqueteria, State.EnBodegaPendientePago));
  }

  // Entrega fallida y reintento: sale a ruta, vuelve a bodega y se entrega.
  add(
    ShipmentType.Paqueteria,
    [...pathTo(Flow.Paqueteria, State.EnRutaEntrega), State.DevueltoBodega, State.EnRutaEntrega, State.Entregado],
    [DeliveryOutcome.DevueltoBodega, DeliveryOutcome.Entregado],
  );

  // --- Transporte: los 10 estados repartidos entre los tres tipos ---
  const transportStates = statesOf(Flow.Transporte);
  const transportTypes = [ShipmentType.Aereo, ShipmentType.MaritimoFCL, ShipmentType.MaritimoLCL];
  transportStates.forEach((state, i) => {
    const type = transportTypes[i % transportTypes.length]!;
    const attempts = state === State.Entregado ? [DeliveryOutcome.Entregado] : [];
    add(type, pathTo(Flow.Transporte, state), attempts);
  });
  // Uno mas por tipo en pleno proceso, para que ninguno quede con un solo caso.
  add(ShipmentType.Aereo, pathTo(Flow.Transporte, State.FacturacionEnProceso));
  add(ShipmentType.MaritimoFCL, pathTo(Flow.Transporte, State.EnTransitoDestino));
  add(ShipmentType.MaritimoLCL, pathTo(Flow.Transporte, State.EnBodegaPendientePago));

  // --- Agenciamiento: un tramite en cada uno de sus 11 estados ---
  for (const state of statesOf(Flow.Agenciamiento)) {
    const attempts = state === State.Entregado ? [DeliveryOutcome.Entregado] : [];
    add(ShipmentType.Agenciamiento, pathTo(Flow.Agenciamiento, state), attempts);
  }

  // Invariante de cobertura: ningun estado del dominio se queda sin un tramite
  // que mostrarlo. Si manana se agrega uno a la maquina, este seed lo delata.
  const covered = new Set(out.map((s) => s.path[s.path.length - 1]!));
  const missing = STATE_VALUES.filter((s) => !covered.has(s));
  if (missing.length > 0) {
    throw new Error(`[seed-demo] Estados sin ningún trámite de demo: ${missing.join(', ')}`);
  }

  return out;
}

// ---------------------------------------------------------------------------
// 4. Siembra
// ---------------------------------------------------------------------------

/**
 * Conexion dentro de la transaccion. TODA la siembra corre en una sola: si algo
 * falla a mitad (una tabla sin migrar, un dato invalido), la base queda como
 * estaba y no en un limbo a medio sembrar que confunda al proximo intento.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Borra SOLO lo que sembro este archivo. Nunca toca datos reales. */
async function resetDemo(tx: Tx): Promise<void> {
  const demoUsers = await tx
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${DEMO_DOMAIN}`));
  const userIds = demoUsers.map((u) => u.id);

  if (userIds.length > 0) {
    const demoClients = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(inArray(clients.userId, userIds));
    const clientIds = demoClients.map((c) => c.id);
    // Los tramites no caen con el casillero (no hay cascade): se borran primero.
    // Eso si arrastra eventos, costos, pagos e intentos de entrega.
    if (clientIds.length > 0) {
      await tx.delete(shipments).where(inArray(shipments.clientId, clientIds));
    }
    await tx.delete(users).where(inArray(users.id, userIds));
  }

  // La tasa vigente (`app_settings`) NO se toca: es una fila unica del sistema y
  // la demo solo la crea cuando no existia, asi que aqui no hay nada que devolver
  // a su valor anterior. Del historial si se limpia lo que sembro este archivo.
  await tx.delete(exchangeRateHistory).where(eq(exchangeRateHistory.note, DEMO_RATE_NOTE));
  await tx.delete(costServices).where(inArray(costServices.name, SERVICES.map((s) => s.name)));
  await tx.delete(announcements).where(inArray(announcements.title, ANNOUNCEMENTS.map((a) => a.title)));
  await tx
    .delete(districtRoutes)
    .where(inArray(districtRoutes.districtCode, ROUTES.flatMap((r) => r.districts)));

  console.log('[seed-demo] Datos de demo anteriores eliminados.');
}

/** Consecutivos de negocio: se piden a la misma secuencia que usa la API. */
async function nextSequence(
  tx: Tx,
  name: 'hs_shipment_code_seq' | 'hs_client_code_seq',
  n: number,
): Promise<string[]> {
  const query =
    name === 'hs_shipment_code_seq'
      ? sql`select nextval('hs_shipment_code_seq') as val from generate_series(1, ${n})`
      : sql`select nextval('hs_client_code_seq') as val from generate_series(1, ${n})`;
  const rows = (await tx.execute(query)) as Array<{ val: string }>;
  if (rows.length !== n) throw new Error(`[seed-demo] No se pudieron generar ${n} consecutivos.`);
  return rows.map((r) => String(r.val));
}

async function seed(tx: Tx): Promise<void> {
  const reset = process.argv.includes('--reset') || process.env.SEED_DEMO_RESET === '1';

  const [existing] = await tx
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${DEMO_DOMAIN}`))
    .limit(1);
  if (existing && !reset) {
    console.log('[seed-demo] Ya hay datos de demo sembrados. No se cambió nada.');
    console.log('  Para borrarlos y volver a sembrarlos: agrega -- --reset');
    return;
  }
  if (reset) await resetDemo(tx);

  // --- Tarifas de cliente: las siembra `db:seed`, aqui solo se usan ---
  const rates = await tx.select().from(clientRates);
  if (rates.length === 0) {
    throw new Error('[seed-demo] No hay tarifas de cliente. Corre primero: pnpm --filter @courier/api db:seed');
  }
  const rateByName = new Map(rates.map((r) => [r.name, r]));
  const defaultRate = rates.find((r) => r.isDefault) ?? rates[0]!;

  // --- Usuarios (una sola derivacion de clave para todos: es data falsa) ---
  const passwordHash = await hash(DEMO_PASSWORD);

  const staffRows = await tx
    .insert(users)
    .values(
      STAFF.map((s) => ({
        email: email(s.handle),
        passwordHash,
        principal: Principal.Staff,
        role: s.role,
        name: s.name,
        phone: s.phone,
        status: s.status ?? UserStatus.Activo,
        emailVerifiedAt: daysAgo(200),
        createdAt: daysAgo(200),
      })),
    )
    .returning({ id: users.id, email: users.email, role: users.role });

  const staffByRole = (role: Role): string => {
    const row = staffRows.find((r) => r.role === role);
    if (!row) throw new Error(`[seed-demo] Falta el usuario de staff con rol ${role}.`);
    return row.id;
  };
  const adminId = staffByRole(Role.Admin);
  const agentId = staffByRole(Role.ServicioCliente);
  const opsId = staffByRole(Role.Operativo);
  const financeId = staffByRole(Role.Financiero);
  const courierIds = staffRows.filter((r) => r.role === Role.Mensajeria).map((r) => r.id);

  // --- Casilleros ---
  const clientUserRows = await tx
    .insert(users)
    .values(
      CLIENTS.map((c) => ({
        email: email(c.handle),
        passwordHash,
        principal: Principal.Client,
        role: Role.Client,
        name: c.name,
        phone: c.phone,
        status: c.status ?? UserStatus.Activo,
        emailVerifiedAt: c.verified === false ? null : daysAgo(c.memberSinceDays),
        createdAt: daysAgo(c.memberSinceDays),
      })),
    )
    .returning({ id: users.id, email: users.email, name: users.name });

  const clientCodes = await nextSequence(tx, 'hs_client_code_seq', CLIENTS.length);
  const clientRows = await tx
    .insert(clients)
    .values(
      CLIENTS.map((c, i) => {
        const userRow = clientUserRows.find((u) => u.email === email(c.handle))!;
        const synced = c.helga === HelgaSyncStatus.Synced;
        const seq = clientCodes[i]!;
        return {
          userId: userRow.id,
          code: `HS-${seq}`,
          idNumber: c.idNumber,
          ...locationOf(c.districtCode),
          addressLine: c.addressLine,
          reviewStatus: c.reviewStatus,
          clientRateId: (rateByName.get(c.rate) ?? defaultRate).id,
          // Techo de politica comercial: monto + moneda explicita, sin tasa (M2).
          creditLimit: c.creditLimit?.amount ?? null,
          creditLimitCurrency: c.creditLimit?.currency ?? null,
          helgaClientId: synced ? `HLG-${seq}` : null,
          helgaSubLocker: synced ? `SJO008835S${String(seq).slice(-3)}` : null,
          helgaSyncedAt: synced ? daysAgo(c.memberSinceDays) : null,
          helgaSyncStatus: c.helga,
          helgaSyncAttempts: c.helga === HelgaSyncStatus.Pending ? 0 : c.helga === HelgaSyncStatus.Failed ? 3 : 1,
          helgaLastError:
            c.helga === HelgaSyncStatus.Failed ? 'El proveedor rechazó la cédula: ya existe otro destinatario con ese documento.' : null,
          memberSince: isoDay(daysAgo(c.memberSinceDays)),
          createdAt: daysAgo(c.memberSinceDays),
        };
      }),
    )
    .returning({ id: clients.id, code: clients.code });

  // --- Catalogo de servicios de costo ---
  await tx
    .insert(costServices)
    .values(
      SERVICES.map((s) => ({
        name: s.name,
        kind: s.kind,
        category: s.category,
        electronicInvoiceCode: s.electronicInvoiceCode,
        valueType: s.valueType,
        defaultValue: s.defaultValue,
        currency: s.currency,
        enabled: s.enabled ?? true,
      })),
    )
    .onConflictDoNothing();
  const serviceRows = await tx.select({ id: costServices.id, name: costServices.name }).from(costServices);
  const serviceByName = new Map(serviceRows.map((s) => [s.name, s.id]));
  const serviceId = (name: string): string | null => serviceByName.get(name) ?? null;
  /**
   * Spec del catalogo por ID, para copiarle categoria y COD SIS FE a cada linea
   * de costo igual que hace la API al guardar (la linea es un snapshot, no una
   * lectura en vivo del catalogo).
   */
  const specById = new Map(
    SERVICES.flatMap((s) => {
      const id = serviceByName.get(s.name);
      return id ? [[id, s] as const] : [];
    }),
  );

  // --- Rutas por distrito ---
  await tx
    .insert(districtRoutes)
    .values(
      ROUTES.flatMap((r) =>
        r.districts.map((districtCode) => {
          if (!findDistrict(districtCode)) {
            throw new Error(`[seed-demo] Distrito inexistente en la definición de rutas: ${districtCode}`);
          }
          return { districtCode, routeNumber: r.routeNumber };
        }),
      ),
    )
    .onConflictDoNothing();

  // --- Anuncios ---
  await tx.insert(announcements).values(ANNOUNCEMENTS.map((a) => ({ ...a })));

  /**
   * Tasa de cambio vigente del sistema. Sin ella la demo no deja cargar costos a
   * nadie salvo a quien puede fijarla, que es la regla real (`resolveExchangeRate`)
   * pero no lo que se quiere mostrar.
   *
   * Solo se siembra si NO habia ninguna: la tasa es un valor unico del sistema y
   * pisar la que un administrador ya fijo seria cambiarle el dinero, no sembrar
   * datos de demo. Si se siembra, va con su registro en el historial: aqui no
   * existe una tasa vigente sin el rastro de quien la puso.
   */
  const rateSetAt = daysAgo(1);
  const seededRate = await tx
    .insert(appSettings)
    .values({
      id: SETTINGS_ROW_ID,
      exchangeRate: DEMO_EXCHANGE_RATE,
      exchangeRateSetBy: adminId,
      exchangeRateSetAt: rateSetAt,
      // La tarifa de flete viaja en el mismo upsert: sin ella el reporte FULL de
      // Paqueteria sale sin costo de transporte y, por tanto, sin margen.
      freightRateUsdPerLb: DEMO_FREIGHT_RATE,
      freightRateSetBy: adminId,
      freightRateSetAt: rateSetAt,
      updatedAt: rateSetAt,
    })
    .onConflictDoNothing()
    .returning({ id: appSettings.id });
  if (seededRate.length > 0) {
    await tx.insert(exchangeRateHistory).values({
      rate: DEMO_EXCHANGE_RATE,
      previousRate: null,
      note: DEMO_RATE_NOTE,
      setBy: adminId,
      setAt: rateSetAt,
    });
    await tx.insert(freightRateHistory).values({
      usdPerLb: DEMO_FREIGHT_RATE,
      previousUsdPerLb: null,
      note: DEMO_FREIGHT_NOTE,
      setBy: adminId,
      setAt: rateSetAt,
    });
  }

  /**
   * Tasa con la que se siembra TODO el dinero de la demo. Es la vigente del
   * sistema: la que acaba de sembrarse o, si ya habia una, esa. Una sola para
   * todos los tramites, igual que en produccion, donde el numero no lo elige
   * cada quien al cargar sino quien tiene `exchange_rate.write`.
   */
  const [currentRate] = await tx
    .select({ rate: appSettings.exchangeRate })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ROW_ID))
    .limit(1);
  const exchangeRate = currentRate?.rate ?? DEMO_EXCHANGE_RATE;

  // --- Tramites, con su historial, costos, pagos y entregas ---
  const scenarios = buildScenarios();
  const codes = await nextSequence(tx, 'hs_shipment_code_seq', scenarios.length);

  type EventRow = typeof shipmentEvents.$inferInsert;
  type CostRow = typeof shipmentCosts.$inferInsert;
  type PaymentRow = typeof payments.$inferInsert;
  type AttemptRow = typeof deliveryAttempts.$inferInsert;
  const eventRows: EventRow[] = [];
  const costRows: CostRow[] = [];
  const paymentRows: PaymentRow[] = [];
  const attemptRows: AttemptRow[] = [];

  for (const [i, sc] of scenarios.entries()) {
    const flow = flowForType(sc.type);
    const isPackage = sc.type === ShipmentType.Paqueteria;
    const client = clientRows[sc.clientIdx]!;
    const clientSpec = CLIENTS[sc.clientIdx]!;
    const rate = rateByName.get(clientSpec.rate) ?? defaultRate;

    const times = timeline(sc.startDays, sc.path.length);
    const finalState = sc.path[sc.path.length - 1]!;
    /** Instante en que el tramite ENTRO por ultima vez a ese estado. */
    const at = (state: State): Date | null => {
      const idx = sc.path.lastIndexOf(state);
      return idx >= 0 ? times[idx]! : null;
    };
    const reached = (state: State): boolean => sc.path.includes(state);

    // La tasa (`exchangeRate`, colones por 1 USD) es la VIGENTE del sistema, la
    // misma para todos los tramites: la fija quien tiene `exchange_rate.write`,
    // no se elige al cargar cada uno. Se congela igual con cada monto que se
    // guarde debajo (regla M5).

    const item = PACKAGE_ITEMS[i % PACKAGE_ITEMS.length]!;
    const cargo = CARGO_ITEMS[i % CARGO_ITEMS.length]!;
    const weightKg = isPackage ? 1 + ((i * 7) % 18) : null;
    const receivedInMiami = reached(State.RecibidoBodegaMiami);

    // 1) Lineas de costo: existen desde que el tramite entra a facturacion.
    const billingAt = at(State.FacturacionEnProceso);
    const lines: { costServiceId: string | null; label: string; source: CostLineSource; percentage: number | null; amount: number; currency: Currency }[] = [];

    if (billingAt) {
      if (isPackage) {
        // Flete = peso (entero) x precio por kg de la tarifa del cliente, en USD.
        lines.push({
          costServiceId: null,
          label: `Flete ${weightKg} kg`,
          source: CostLineSource.Freight,
          percentage: null,
          amount: roundMoney(weightKg! * rate.pricePerKg, Currency.USD),
          currency: Currency.USD,
        });
        lines.push({
          costServiceId: serviceId('Manejo en bodega Miami'),
          label: 'Manejo en bodega Miami',
          source: CostLineSource.Service,
          percentage: null,
          amount: 3.5,
          currency: Currency.USD,
        });
        if (i % 3 === 0) {
          lines.push({
            costServiceId: serviceId('Asesoría de compra por Internet'),
            label: 'Asesoría de compra por Internet',
            source: CostLineSource.Service,
            percentage: null,
            amount: 12,
            currency: Currency.USD,
          });
        }
        if (i % 4 === 0) {
          lines.push({
            costServiceId: serviceId('Empaque especial'),
            label: 'Empaque especial',
            source: CostLineSource.Service,
            percentage: null,
            amount: 7,
            currency: Currency.USD,
          });
        }
        // Porcentaje SIEMPRE sobre las lineas que no son porcentaje.
        const base = percentageBase(
          lines.map((l) => ({ amount: l.amount, currency: l.currency, exchangeRate, source: l.source })),
          Currency.USD,
        );
        lines.push({
          costServiceId: serviceId('Permisos de Importación'),
          label: 'Permisos de Importación',
          source: CostLineSource.Percentage,
          percentage: 10,
          amount: applyPercentage(base, 10, Currency.USD),
          currency: Currency.USD,
        });
        if (i % 5 === 0) {
          lines.push({
            costServiceId: serviceId('Seguro de mercancía'),
            label: 'Seguro de mercancía',
            source: CostLineSource.Percentage,
            percentage: 2.5,
            amount: applyPercentage(base, 2.5, Currency.USD),
            currency: Currency.USD,
          });
        }
      } else {
        // Transporte y agenciamiento: todo se digita al recibir (valor Manual).
        const manual: { name: string; amount: number; currency: Currency }[] = [
          { name: 'Transporte terrestre', amount: 45_000 + (i % 4) * 7_500, currency: Currency.CRC },
          { name: 'Almacenaje fiscal', amount: 28_500 + (i % 3) * 6_000, currency: Currency.CRC },
          { name: 'Impuesto de aduana', amount: 132_750 + (i % 6) * 12_400, currency: Currency.CRC },
        ];
        if (sc.type === ShipmentType.Agenciamiento) {
          manual.push({ name: 'Honorarios de agenciamiento', amount: 65_000, currency: Currency.CRC });
          manual.push({ name: 'Inspección Dekra', amount: 52_000, currency: Currency.CRC });
        } else {
          // Una linea en dolares: la factura mezcla monedas y cada una lleva la suya.
          manual.push({ name: 'Desalmacenaje', amount: 85 + (i % 5) * 15, currency: Currency.USD });
        }
        for (const m of manual) {
          lines.push({
            costServiceId: serviceId(m.name),
            label: m.name,
            source: CostLineSource.Service,
            percentage: null,
            amount: m.amount,
            currency: m.currency,
          });
        }
      }
    }

    // 2) Aprobacion: congela el total de la factura en AMBAS monedas. Solo cuando
    //    el tramite ya paso a "En bodega - Pendiente pago" (Condition.RequiresInvoiceAmount).
    const approvedAt = at(State.EnBodegaPendientePago);
    const totals = lines.length > 0 ? computeTotals(lines.map((l) => ({ amount: l.amount, currency: l.currency, exchangeRate }))) : null;
    const approved = approvedAt !== null && totals !== null;

    const [shipment] = await tx
      .insert(shipments)
      .values({
        code: formatShipmentCode(codes[i]!),
        clientId: client.id,
        shipmentType: sc.type,
        state: finalState,
        tracking: isPackage
          ? `1Z${String(4200 + i)}W${String(90_000 + i * 137)}`
          : sc.type === ShipmentType.Aereo
            ? `045-${String(12_345_600 + i * 11)}`
            : `MSCU${String(4_180_000 + i * 73)}`,
        description: isPackage ? item.description : cargo.description,
        store: isPackage ? item.store : null,
        carrier: isPackage ? item.carrier : null,
        // Formato de la etiqueta real ("LES48450141"). Con el prefijo "HAWB-" los
        // datos demo no se podian recibir en bodega: lo que se escanea es esto.
        hawb: isPackage && receivedInMiami ? `LES${String(48_450_100 + i * 19)}` : null,
        weightKg,
        declaredValueUsd: isPackage ? roundMoney(45 + ((i * 37) % 420), Currency.USD) : null,
        insuredValueUsd: isPackage && i % 4 === 0 ? roundMoney(120 + (i % 6) * 45, Currency.USD) : null,
        tariffPosition: isPackage && i % 3 === 0 ? `8517.62.00.${String(10 + (i % 80)).padStart(2, '0')}` : null,
        retain: isPackage ? i % 7 === 0 : null,
        warehouse: isPackage ? null : cargo.warehouse,
        dua: isPackage ? null : cargo.dua,
        billingNotes: isPackage ? null : cargo.notes,
        invoiceTotalUsd: approved ? totals!.usd : null,
        invoiceTotalCrc: approved ? totals!.crc : null,
        // Snapshot de la tarifa de flete, igual que `costsRepo.freezeInvoice`:
        // solo Paqueteria, y solo cuando la factura quedo congelada.
        freightRateUsdPerLb: approved && isPackage ? DEMO_FREIGHT_RATE : null,
        costsApprovedAt: approved ? approvedAt : null,
        costsApprovedBy: approved ? financeId : null,
        helgaPrealertStatus: isPackage
          ? receivedInMiami
            ? HelgaSyncStatus.Synced
            : i % 5 === 0
              ? HelgaSyncStatus.Failed
              : HelgaSyncStatus.Pending
          : null,
        helgaPrealertAttempts: isPackage ? (receivedInMiami ? 1 : i % 5 === 0 ? 2 : 0) : 0,
        helgaPrealertError:
          isPackage && !receivedInMiami && i % 5 === 0
            ? 'El proveedor no aceptó la prealerta: el casillero aún no está enlazado.'
            : null,
        // La prealerta de paqueteria la hace el cliente; el resto lo abre el staff.
        createdBy: isPackage ? null : i % 2 === 0 ? agentId : adminId,
        createdAt: times[0]!,
        updatedAt: times[times.length - 1]!,
      })
      .returning({ id: shipments.id, code: shipments.code });

    const shipmentId = shipment!.id;

    // 3) Historial de estados (append-only, un evento por paso).
    sc.path.forEach((state, idx) => {
      eventRows.push({
        shipmentId,
        state,
        note:
          state === State.DevueltoBodega
            ? 'El cliente no se encontraba en la dirección. Se reprograma la entrega.'
            : idx === 0
              ? 'Trámite creado.'
              : null,
        createdBy:
          idx === 0
            ? isPackage
              ? null
              : agentId
            : state === State.EnRutaEntrega || state === State.Entregado || state === State.DevueltoBodega
              ? courierIds[idx % courierIds.length]!
              : state === State.FacturacionEnProceso
                ? financeId
                : opsId,
        createdAt: times[idx]!,
      });
    });

    // 4) Lineas de costo (cada una con su moneda y su tasa: snapshot, M2 + M5).
    for (const line of lines) {
      const spec = line.costServiceId ? specById.get(line.costServiceId) : undefined;
      costRows.push({
        shipmentId,
        costServiceId: line.costServiceId,
        label: line.label,
        // Snapshot del catalogo, igual que en `costsService.save`. El flete no
        // sale de ningun servicio: `categoryForLine` le impone CostCategory.Flete.
        category: categoryForLine(line.source, spec?.category),
        electronicInvoiceCode: spec?.electronicInvoiceCode ?? null,
        source: line.source,
        percentage: line.percentage,
        amount: line.amount,
        currency: line.currency,
        exchangeRate,
        createdBy: financeId,
        createdAt: billingAt!,
      });
    }

    // 5) Pagos. El monto a cubrir es el total congelado en colones.
    if (approved && sc.payment !== 'none') {
      const dueCrc = totals!.crc;
      const paidAt = at(State.EnRutaEntrega) ?? new Date(Math.min(NOW.getTime(), approvedAt!.getTime() + DAY));
      /** Dolares que cubren una deuda en colones sin quedarse corto por redondeo. */
      const usdFor = (crc: number): number => Math.ceil((crc / exchangeRate) * 100) / 100;
      const receipt = `${1_240_000 + i * 13}`;

      const deposit = (amount: number, status: PaymentStatus, note: string | null = null): PaymentRow => ({
        shipmentId,
        method: PaymentMethod.DepositoBancario,
        status,
        amount,
        currency: Currency.CRC,
        exchangeRate,
        /**
         * Una cuenta de las que ESE tramite admite (Paqueteria solo las de
         * dolares), alternando banco. Elegirla a mano dejaria depositos de
         * Paqueteria en cuentas de colones, que es justo lo que el formulario
         * del cliente no permite: datos de demo que no se pueden reproducir.
         */
        bankAccount: pickAccount(sc.type, i),
        receiptNumber: receipt,
        depositedAt: paidAt,
        receiptFileKey: `receipts/demo-${shipment!.code}.pdf`,
        note,
        createdBy: null,
        confirmedBy: status === PaymentStatus.Pendiente ? null : financeId,
        confirmedAt: status === PaymentStatus.Pendiente ? null : paidAt,
        createdAt: paidAt,
      });

      const card = (amountUsd: number): PaymentRow => ({
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
        gatewayReference: `onvo_pi_demo_${String(i).padStart(3, '0')}`,
        note: null,
        createdBy: null,
        confirmedBy: null,
        confirmedAt: paidAt,
        createdAt: paidAt,
      });

      const mine: PaymentRow[] = [];
      switch (sc.payment) {
        case 'pending':
          mine.push(deposit(dueCrc, PaymentStatus.Pendiente));
          break;
        case 'rejected':
          mine.push(deposit(dueCrc, PaymentStatus.Rechazado, 'El comprobante no corresponde al monto facturado.'));
          break;
        case 'partial':
          mine.push(deposit(roundMoney(dueCrc * 0.4, Currency.CRC), PaymentStatus.Confirmado, 'Abono parcial.'));
          break;
        case 'full-deposit':
          mine.push(deposit(dueCrc, PaymentStatus.Confirmado));
          break;
        case 'full-card':
          mine.push(card(usdFor(dueCrc)));
          break;
        case 'split': {
          const first = roundMoney(dueCrc * 0.4, Currency.CRC);
          mine.push(deposit(first, PaymentStatus.Confirmado, 'Primer abono.'));
          mine.push(card(usdFor(dueCrc - first)));
          break;
        }
      }

      // Invariante: si el tramite salio a ruta, el pago DEBE estar cubierto
      // (Condition.RequiresConfirmedPayment). Se verifica con la misma funcion
      // que usa la API, no con una cuenta aparte.
      const needsSettled = reached(State.EnRutaEntrega);
      const settleable = mine.map((p) => ({
        amount: p.amount,
        currency: p.currency,
        exchangeRate: p.exchangeRate,
        status: p.status ?? PaymentStatus.Pendiente,
      }));
      if (needsSettled && !isSettled(settleable, dueCrc)) {
        throw new Error(`[seed-demo] ${shipment!.code} salió a ruta sin pago suficiente.`);
      }
      paymentRows.push(...mine);
    }

    // 6) Intentos de entrega (uno por visita del mensajero).
    sc.attempts.forEach((outcome, idx) => {
      const state = outcome === DeliveryOutcome.Entregado ? State.Entregado : State.DevueltoBodega;
      const when = at(state) ?? times[times.length - 1]!;
      attemptRows.push({
        shipmentId,
        outcome,
        photoFileKey: outcome === DeliveryOutcome.Entregado ? `deliveries/demo-${shipment!.code}.jpg` : null,
        note:
          outcome === DeliveryOutcome.DevueltoBodega
            ? 'Nadie atendió en la dirección. Se deja aviso y se reprograma.'
            : null,
        courierId: courierIds[(i + idx) % courierIds.length]!,
        createdAt: when,
      });
    });
  }

  await tx.insert(shipmentEvents).values(eventRows);
  if (costRows.length > 0) await tx.insert(shipmentCosts).values(costRows);
  if (paymentRows.length > 0) await tx.insert(payments).values(paymentRows);
  if (attemptRows.length > 0) await tx.insert(deliveryAttempts).values(attemptRows);

  // --- Resumen ---
  console.log('\n[seed-demo] Datos de demo sembrados:');
  console.log(`  usuarios staff:      ${staffRows.length}`);
  console.log(`  casilleros:          ${clientRows.length} (${clientRows[0]?.code} .. ${clientRows[clientRows.length - 1]?.code})`);
  console.log(`  servicios de costo:  ${SERVICES.length}`);
  console.log(`  distritos con ruta:  ${ROUTES.flatMap((r) => r.districts).length} en ${ROUTES.length} rutas`);
  console.log(`  anuncios:            ${ANNOUNCEMENTS.length}`);
  console.log(
    `  trámites:            ${scenarios.length} (los ${SHIPMENT_TYPE_VALUES.length} tipos, los ${STATE_VALUES.length} estados)`,
  );
  console.log(`  eventos de estado:   ${eventRows.length}`);
  console.log(`  líneas de costo:     ${costRows.length}`);
  console.log(`  pagos:               ${paymentRows.length}`);
  console.log(`  intentos de entrega: ${attemptRows.length}`);
  console.log(`\n  Todos los usuarios de demo entran con la clave: ${DEMO_PASSWORD}`);
  console.log(`  Staff:   ${STAFF.map((s) => email(s.handle)).join(', ')}`);
  console.log(`  Clientes: ${CLIENTS.map((c) => email(c.handle)).join(', ')}`);
  console.log('');
}

db.transaction((tx) => seed(tx))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-demo] error:', err);
    process.exit(1);
  });
