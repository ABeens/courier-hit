/**
 * Lectura y validacion del entorno (docs/02-api.md §3). Si algo falta o es
 * invalido, la API no arranca: fallamos temprano y claro.
 */
import { z } from 'zod';

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
  HELGA_BASE_URL: z.string().url().optional(),
  HELGA_CLIENT_ID: z.coerce.number().int().positive().optional(),
  HELGA_CLIENT_SECRET: z.string().optional(),
  HELGA_USERNAME: z.string().optional(),
  HELGA_PASSWORD: z.string().optional(),
  HELGA_APP_ID: z.string().optional(),
  // Origin registrado en la lista blanca; Helga responde 403 si no coincide.
  HELGA_ORIGIN: z.string().optional(),
  HELGA_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
}).superRefine((env, ctx) => {
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
