/**
 * Lectura y validacion del entorno (docs/02-api.md §3). Si algo falta o es
 * invalido, la API no arranca: fallamos temprano y claro.
 */
import { z } from 'zod';
import { isValidDuration, parseDuration } from './scheduler/duration';

/**
 * Variable opcional que puede venir vacia o con un placeholder de plantilla.
 * `.optional()` solo tolera la AUSENCIA; una cadena vacia (o un `<ambiente>`
 * sin reemplazar, como el que trae .env.example) es un valor presente e
 * invalido, y tumbaria el arranque aunque la integracion este apagada. Aqui se
 * normaliza a `undefined` para que la validacion fuerte quede donde importa:
 * el superRefine que corre solo con la integracion encendida.
 */
function optionalEnv() {
  return z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    return trimmed === '' || /^<.*>$/.test(trimmed) ? undefined : trimmed;
  }, z.string().optional());
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria.'),
  WEB_ORIGIN: z.string().url().default('http://localhost:4321'),
  SESSION_COOKIE_NAME: z.string().default('hs_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  EMAIL_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  EMAIL_CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Invitacion de staff: el token de fijar contrasena dura mas que un codigo (docs/roles.md §1.3.4).
  INVITE_TTL_HOURS: z.coerce.number().int().positive().default(72),

  // --- Almacen de archivos adjuntos (comprobantes de pago, fotos de entrega) ---
  // Directorio local donde se guardan los archivos subidos. Es el driver de
  // desarrollo: sirve para operar de punta a punta sin depender de la nube.
  // TODO(12): en AWS esto pasa a S3 (bucket privado + URLs firmadas). El contrato
  // de `core/storage.ts` ya esta pensado para ese cambio: se sustituye el driver,
  // no los modulos que lo usan.
  UPLOADS_DIR: z.string().default('./uploads'),
  /** Techo del tamaño de un adjunto. Una foto de celular ronda los 3-5 MB. */
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),

  // --- Correo saliente (verificacion, invitaciones, avisos de estado) ---
  // Apagado mientras no exista el servidor en AWS. Con el interruptor en false,
  // `mailer` escribe el mensaje completo en la consola: los flujos que disparan
  // correo se pueden probar enteros sin SES.
  MAIL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MAIL_FROM: z.string().default('HS Global Courier <no-reply@hsglobalcr.com>'),
  /** Region de SES. Obligatoria con MAIL_ENABLED=true (ver superRefine). */
  AWS_REGION: optionalEnv(),
  /**
   * Credenciales de SES. OPCIONALES a proposito: en EC2/ECS lo correcto es el rol
   * de instancia, y el SDK lo resuelve solo cuando estas no estan. Se declaran
   * para poder probar desde fuera de AWS sin cambiar codigo.
   */
  SES_ACCESS_KEY_ID: optionalEnv(),
  SES_SECRET_ACCESS_KEY: optionalEnv(),
  /** Configuration set de SES (metricas y manejo de rebotes). Opcional. */
  SES_CONFIGURATION_SET: optionalEnv(),

  // --- Pasarela de pago: Onvo Pay ---
  // Apagada mientras no existan credenciales. Con la pasarela apagada el pago con
  // tarjeta no se ofrece y el cliente paga por deposito bancario, que es un flujo
  // completo y no depende de terceros.
  ONVO_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Pasarela SIMULADA: ofrece el pago con tarjeta sin llamar a Onvo ni tener
   * credenciales. Existe para que la ausencia de la pasarela deje de bloquear las
   * pruebas: el flujo completo (crear el intento, confirmarlo, ver el tramite
   * pagado) se puede recorrer con `ONVO_ENABLED=false`.
   *
   * NUNCA en produccion: una pasarela simulada da por cobrado dinero que nadie
   * pago. El arranque falla si se enciende ahi (ver `loadConfig`), en vez de
   * ignorarla en silencio.
   */
  ONVO_SIMULATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ONVO_BASE_URL: optionalEnv(),
  ONVO_SECRET_KEY: optionalEnv(),
  ONVO_PUBLIC_KEY: optionalEnv(),
  /** Secreto con el que Onvo firma los webhooks; sin el no se puede confiar en uno. */
  ONVO_WEBHOOK_SECRET: optionalEnv(),
  ONVO_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // --- Proveedor de casillero en Miami: Helga (docs/13 §5) ---
  // Interruptor de la integracion. En desarrollo va apagado: la IP local no esta
  // en la lista blanca de Helga, asi que ninguna llamada saliente funcionaria y
  // el registro (que bloquea si el proveedor falla) seria imposible de probar.
  // TODO(13): encenderlo por defecto en produccion cuando la IP fija del backend
  // este en la whitelist y las credenciales esten cargadas.
  HELGA_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // La validez de URL se exige abajo, solo con la integracion encendida.
  HELGA_BASE_URL: optionalEnv(),
  HELGA_CLIENT_ID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  HELGA_CLIENT_SECRET: optionalEnv(),
  HELGA_USERNAME: optionalEnv(),
  HELGA_PASSWORD: optionalEnv(),
  HELGA_APP_ID: optionalEnv(),
  // Origin registrado en la lista blanca; Helga responde 403 si no coincide.
  HELGA_ORIGIN: optionalEnv(),
  HELGA_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * Proveedor SIMULADO: responde las cinco operaciones de Helga sin red ni
   * credenciales (`integrations/helga/helga.mock.ts`). Existe porque con la
   * integracion apagada NADA del flujo se puede probar: los casilleros quedan
   * 'pending', las prealertas no salen y el robot ni siquiera agenda sus tareas.
   *
   * La sustitucion ocurre en el transporte (el `fetch`), no en los servicios: el
   * armado de cada peticion, el parseo de la envoltura y el avance de estados
   * corren igual que en produccion.
   *
   * NUNCA en produccion: daria por enlazados casilleros que el proveedor no
   * conoce y por prealertados paquetes que nadie espera en Miami. El arranque
   * falla si se enciende ahi (ver mas abajo), no se degrada en silencio.
   */
  HELGA_MOCK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Cuanto tarda el paquete simulado en pasar de un estado del proveedor al
   * siguiente. Son 8 pasos hasta el final del tramo, asi que con "2m" el recorrido
   * completo dura 16 minutos.
   *
   * Comparalo con `PROVIDER_SYNC_INTERVAL`: si el paso es MAS CORTO que el
   * intervalo, el paquete salta varios estados entre corridas y se ejercita el
   * avance paso a paso de `provider-sync` (el caso realista). Si es mas largo, se
   * ve un estado por corrida, que es comodo para mirar el timeline del portal.
   */
  HELGA_MOCK_STEP: z
    .string()
    .default('2m')
    .refine(isValidDuration, {
      message: 'HELGA_MOCK_STEP debe ser una duracion valida (p. ej. "30s", "2m", "1h").',
    }),

  // --- Tasa de cambio sugerida: web service de indicadores del BCCR ---
  // Solo SUGIERE la tasa del dia en la pantalla de costos; el operador es quien
  // la digita y esa es la que se guarda. Por eso la integracion es opcional y
  // apagarla no degrada ninguna funcion: el campo simplemente arranca vacio.
  BCCR_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  BCCR_BASE_URL: optionalEnv(),
  /** 318 = tipo de cambio de VENTA del dolar (el que se le cobra al cliente). */
  BCCR_INDICATOR: z.coerce.number().int().positive().default(318),
  /** Nombre y correo registrados en la suscripcion al web service del BCCR. */
  BCCR_NAME: optionalEnv(),
  BCCR_EMAIL: optionalEnv(),
  BCCR_TOKEN: optionalEnv(),
  BCCR_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // --- Robot de tareas programadas (scheduler) ---
  // Interruptor del robot que corre tareas de fondo cada cierto intervalo. En
  // desarrollo va apagado: no queremos temporizadores disparando llamadas a
  // integraciones (Helga) mientras se trabaja en local. Se enciende en el
  // ambiente que deba operar las tareas de forma desatendida.
  SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Cada cuanto sincronizar estados con el proveedor. Duracion legible: acepta
  // cualquier unidad ("30m", "2h", "1d", "90s", "1h30m"). Se valida el formato
  // aqui para fallar al arrancar, no en la primera corrida.
  PROVIDER_SYNC_INTERVAL: z
    .string()
    .default('15m')
    .refine(isValidDuration, {
      message: 'PROVIDER_SYNC_INTERVAL debe ser una duracion valida (p. ej. "30m", "2h", "1d").',
    }),
  // Reconciliacion del enlace de casilleros con Helga (reintenta los pending/failed).
  HELGA_LINK_RECONCILE_INTERVAL: z
    .string()
    .default('1h')
    .refine(isValidDuration, {
      message: 'HELGA_LINK_RECONCILE_INTERVAL debe ser una duracion valida (p. ej. "1h", "30m").',
    }),
  // Reconciliacion de prealertas con Helga (reenvia las pending/failed ya enlazadas).
  HELGA_PREALERT_RECONCILE_INTERVAL: z
    .string()
    .default('30m')
    .refine(isValidDuration, {
      message: 'HELGA_PREALERT_RECONCILE_INTERVAL debe ser una duracion valida (p. ej. "30m", "2h").',
    }),
  // Descubrimiento de paquetes creados directamente en Helga (flujo 2, docs/13 §3.3).
  // OJO: la op. E solo lista paquetes en DIGITADO; en cuanto avanzan salen del
  // listado y se pierden para el robot. Este intervalo tiene que ser MAS CORTO que
  // el tiempo tipico que tarda un paquete en pasar de DIGITADO a AGRUPADA.
  HELGA_DISCOVERY_INTERVAL: z
    .string()
    .default('15m')
    .refine(isValidDuration, {
      message: 'HELGA_DISCOVERY_INTERVAL debe ser una duracion valida (p. ej. "15m", "1h").',
    }),
}).superRefine((env, ctx) => {
  // OJO: el BCCR NO se valida aqui a proposito. A diferencia de Helga, encenderlo
  // sin credenciales NO tumba el arranque: es un interruptor que se puede prender
  // y apagar mientras se consiguen las credenciales. Ver `bccrReady` mas abajo.

  // Correo: con el interruptor encendido la region deja de ser opcional. Va ANTES
  // del early return de Helga, que solo mira su propia integracion.
  if (env.MAIL_ENABLED === true && !env.AWS_REGION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AWS_REGION'],
      message: 'AWS_REGION es obligatoria con MAIL_ENABLED=true (region de SES).',
    });
  }

  // Si la integracion esta encendida, sus credenciales dejan de ser opcionales:
  // preferimos no arrancar a descubrirlo en el primer registro de un cliente.
  if (!(env.HELGA_ENABLED === true)) return;
  const required = [
    'HELGA_BASE_URL',
    'HELGA_CLIENT_ID',
    'HELGA_CLIENT_SECRET',
    'HELGA_USERNAME',
    'HELGA_PASSWORD',
    'HELGA_ORIGIN',
  ] as const;
  for (const key of required) {
    if (env[key] === undefined || env[key] === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} es obligatoria con HELGA_ENABLED=true.`,
      });
    }
  }
  // Con la integracion encendida el endpoint SI tiene que ser una URL real.
  if (env.HELGA_BASE_URL !== undefined && !z.string().url().safeParse(env.HELGA_BASE_URL).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['HELGA_BASE_URL'],
      message: 'HELGA_BASE_URL debe ser una URL válida (reemplaza el placeholder del .env.example).',
    });
  }
});

export type Config = z.infer<typeof EnvSchema>;

function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Configuración de entorno inválida:\n${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();
export const isProd = config.NODE_ENV === 'production';

// Una pasarela simulada en produccion daria por cobrado dinero que nadie pago:
// los pagos con tarjeta se confirmarian solos. No se degrada a apagada en
// silencio, se rechaza el arranque, porque un despliegue con esto encendido es un
// error que hay que ver antes de recibir el primer pedido.
if (config.ONVO_SIMULATE && isProd) {
  throw new Error(
    'Configuración de entorno inválida:\n  - ONVO_SIMULATE: la pasarela simulada no puede ' +
      'usarse con NODE_ENV=production. Apágala y configura las credenciales reales de Onvo.',
  );
}

/**
 * True solo si el BCCR esta ENCENDIDO **y** tiene con que llamar.
 *
 * Es el interruptor efectivo del modulo de costos. Se separa de `BCCR_ENABLED`
 * porque son dos preguntas distintas: "¿lo queremos usar?" (bandera, la mueve
 * quien opera) y "¿ya podemos?" (credenciales, dependen de un tramite externo).
 * Mientras llegan, la bandera se puede prender sin romper nada: la API arranca
 * igual y la pantalla de costos simplemente pide la tasa a mano.
 */
/**
 * En que modo puede cobrar el sistema con tarjeta:
 *
 *   - `live`      — Onvo de verdad: bandera encendida Y credenciales completas.
 *   - `simulated` — pasarela de mentira para probar sin credenciales. Nunca en
 *                   produccion (el arranque lo impide arriba).
 *   - `off`       — no se ofrece tarjeta; el cliente paga por deposito bancario.
 *
 * `live` gana sobre `simulated`: si hay credenciales reales, se cobra de verdad.
 * Dejar que la simulacion pisara una pasarela configurada convertiria un olvido en
 * el .env en pagos fantasma.
 */
export type OnvoMode = 'off' | 'simulated' | 'live';

const onvoLive =
  config.ONVO_ENABLED &&
  Boolean(config.ONVO_BASE_URL && config.ONVO_SECRET_KEY && config.ONVO_PUBLIC_KEY);

export const onvoMode: OnvoMode = onvoLive ? 'live' : config.ONVO_SIMULATE ? 'simulated' : 'off';

/**
 * True si el sistema puede cobrar con tarjeta HOY, de verdad o simulado. Es lo que
 * mira el modulo de pagos para ofrecer el medio; quien necesite distinguir el modo
 * (por ejemplo para no llamar a Onvo) usa `onvoMode`.
 */
export const onvoReady = onvoMode !== 'off';

if (config.ONVO_ENABLED && !onvoLive) {
  console.warn(
    '[config] ONVO_ENABLED=true pero faltan credenciales (ONVO_BASE_URL, ONVO_SECRET_KEY, ' +
      'ONVO_PUBLIC_KEY). El pago con tarjeta seguirá deshabilitado.',
  );
}

if (onvoMode === 'simulated') {
  console.warn(
    '[config] Pasarela de pago SIMULADA (ONVO_SIMULATE=true). Los pagos con tarjeta se ' +
      'confirman sin cobrar nada real. Solo para desarrollo y pruebas.',
  );
}

/**
 * Como habla el sistema con el proveedor de casillero:
 *
 *   - `live`      — Helga de verdad: bandera encendida y credenciales completas.
 *   - `simulated` — proveedor de mentira en proceso, para probar el flujo entero
 *                   sin red ni credenciales. Nunca en produccion.
 *   - `off`       — no se llama a nadie: los casilleros quedan 'pending', las
 *                   prealertas no salen y el robot no agenda sus tareas.
 *
 * `live` gana sobre `simulated`, por la misma razon que en Onvo: si la integracion
 * real esta configurada, un olvido en el .env no debe convertirla en simulacion.
 */
export type HelgaMode = 'off' | 'simulated' | 'live';

export const helgaMode: HelgaMode = config.HELGA_ENABLED
  ? 'live'
  : config.HELGA_MOCK
    ? 'simulated'
    : 'off';

// Un proveedor simulado en produccion daria por enlazados casilleros que Helga no
// conoce y por prealertados paquetes que nadie espera en Miami. Igual que con la
// pasarela: se rechaza el arranque en vez de ignorarlo en silencio.
if (helgaMode === 'simulated' && isProd) {
  throw new Error(
    'Configuración de entorno inválida:\n  - HELGA_MOCK: el proveedor simulado no puede ' +
      'usarse con NODE_ENV=production. Apágalo y configura las credenciales reales de Helga.',
  );
}

/** Duracion de un paso de la linea de tiempo simulada, en milisegundos. */
export const helgaMockStepMs = parseDuration(config.HELGA_MOCK_STEP);

if (helgaMode === 'simulated') {
  console.warn(
    `[config] Proveedor Helga SIMULADO (HELGA_MOCK=true), paso de ${config.HELGA_MOCK_STEP}. ` +
      'Ninguna llamada sale a la red y los ids del proveedor son inventados. ' +
      'Panel de control en /api/dev/helga. Solo para desarrollo y pruebas.',
  );
}

export const bccrReady =
  config.BCCR_ENABLED &&
  Boolean(config.BCCR_BASE_URL && config.BCCR_NAME && config.BCCR_EMAIL && config.BCCR_TOKEN);

// Aviso al arrancar: encendido pero sin credenciales es un estado legitimo y
// temporal, pero silencioso seria confuso ("¿por que no me sugiere la tasa?").
if (config.BCCR_ENABLED && !bccrReady) {
  console.warn(
    '[config] BCCR_ENABLED=true pero faltan credenciales (BCCR_BASE_URL, BCCR_NAME, ' +
      'BCCR_EMAIL, BCCR_TOKEN). La tasa de cambio se seguirá digitando a mano.',
  );
}
