/**
 * Lectura y validacion del entorno (docs/02-api.md §3). Si algo falta o es
 * invalido, la API no arranca: fallamos temprano y claro.
 */
import { z } from 'zod';
import { isValidDuration } from './scheduler/duration';

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
  // Apagado en desarrollo: sin transporte real, `mailer` escribe el mensaje en la
  // consola y sigue. Asi los flujos que disparan correo se pueden probar enteros.
  // TODO(correo): implementar el transporte SES y encenderlo en produccion.
  MAIL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MAIL_FROM: z.string().default('HS Global Courier <no-reply@hsglobalcr.com>'),

  // --- Pasarela de pago: Onvo Pay ---
  // Apagada mientras no existan credenciales. Con la pasarela apagada el pago con
  // tarjeta no se ofrece y el cliente paga por deposito bancario, que es un flujo
  // completo y no depende de terceros.
  // TODO(09/onvo): implementar el cliente de Onvo Pay (crear intento de pago,
  // confirmar contra el webhook) en `integrations/onvo/`.
  ONVO_ENABLED: z
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
}).superRefine((env, ctx) => {
  // OJO: el BCCR NO se valida aqui a proposito. A diferencia de Helga, encenderlo
  // sin credenciales NO tumba el arranque: es un interruptor que se puede prender
  // y apagar mientras se consiguen las credenciales. Ver `bccrReady` mas abajo.

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
 * True solo si la pasarela esta ENCENDIDA **y** tiene con que cobrar. Misma
 * separacion que `bccrReady`: la bandera la mueve quien opera, las credenciales
 * dependen del alta comercial con Onvo. Mientras no este lista, la web no ofrece
 * el pago con tarjeta y el cliente usa deposito bancario.
 */
export const onvoReady =
  config.ONVO_ENABLED &&
  Boolean(config.ONVO_BASE_URL && config.ONVO_SECRET_KEY && config.ONVO_PUBLIC_KEY);

if (config.ONVO_ENABLED && !onvoReady) {
  console.warn(
    '[config] ONVO_ENABLED=true pero faltan credenciales (ONVO_BASE_URL, ONVO_SECRET_KEY, ' +
      'ONVO_PUBLIC_KEY). El pago con tarjeta seguirá deshabilitado.',
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
