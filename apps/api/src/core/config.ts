/**
 * Lectura y validacion del entorno (docs/02-api.md §3). Si algo falta o es
 * invalido, la API no arranca: fallamos temprano y claro.
 */
import { z } from 'zod';

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
