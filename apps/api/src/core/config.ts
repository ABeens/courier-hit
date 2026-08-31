/**
 * Lectura y validacion del entorno (docs/02-api.md §3). Si algo falta o es
 * invalido, la API no arranca: fallamos temprano y claro.
 */
import { z } from 'zod';
import { MAX_ACTIVE_API_KEYS } from '@courier/shared';
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

/**
 * Una cuenta del proveedor Helga. HS Global no opera un solo casillero en Miami
 * sino varios, cada uno con su propio login y su propia ficha del lado del
 * proveedor (SJO008835 "HS GLOBAL", SJO009623 "ZUCA", etc.).
 *
 * `clientId` es el `datos.id` que devuelve `GET /api/casillero/clientes` de esa
 * cuenta, y es el `cliente_id` bajo el que cuelgan sus destinatarios (op. D). Se
 * resuelve en vivo una vez por cuenta; mientras no se conozca va en `null` y esa
 * cuenta no puede dar de alta destinatarios.
 */
const HelgaAccountSchema = z.object({
  /** Codigo de casillero del proveedor, p. ej. `SJO008835`. Identifica la cuenta. */
  code: z.string().min(1),
  /** A nombre de quien esta el casillero, para logs y pantallas. */
  name: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  clientId: z.number().int().positive().nullable().default(null),
});

export type HelgaAccount = z.infer<typeof HelgaAccountSchema>;

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria.'),
  /**
   * Conexiones del pool que atiende las peticiones HTTP. Se fija aqui a
   * proposito: el default de postgres.js son 10, y con 10 basta un par de
   * consultas lentas para que las demas peticiones se queden esperando turno.
   *
   * Techo real: RDS calcula `max_connections` desde la memoria de la instancia
   * (~112 en una db.t4g.micro). Este numero mas `DB_LOCK_POOL_MAX`, multiplicado
   * por la cantidad de instancias de la API, tiene que caber ahi con holgura.
   */
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  /**
   * Conexiones del pool APARTE que sostiene los advisory locks del robot (ver
   * `core/scheduler/with-lock.ts`). Existe separado porque cada tarea en curso
   * reserva una conexion entera durante toda su corrida solo para sostener el
   * candado: sacadas del pool principal, el robot le comeria a las peticiones de
   * los usuarios justo mientras corre.
   *
   * Basta con una por tarea registrada; hoy son 4 (ver `JobLock` en `jobs.ts`).
   */
  DB_LOCK_POOL_MAX: z.coerce.number().int().positive().default(4),
  WEB_ORIGIN: z.string().url().default('http://localhost:4321'),
  SESSION_COOKIE_NAME: z.string().default('hs_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  EMAIL_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  EMAIL_CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Invitacion de staff: el token de fijar contrasena dura mas que un codigo (docs/roles.md §1.3.4).
  INVITE_TTL_HOURS: z.coerce.number().int().positive().default(72),

  // --- API publica para clientes (docs/16) ---
  /**
   * Interruptor de `/api/v1`. Apagada, los endpoints responden 503
   * PUBLIC_API_DISABLED en vez de desaparecer: un integrador merece saber que la
   * API existe y esta en mantenimiento, no un 404 que parece un error suyo.
   *
   * La autogestion de llaves del portal NO depende de esta bandera: un cliente
   * puede revocar una llave filtrada aunque la API este apagada, que es
   * exactamente cuando mas falta hace.
   */
  PUBLIC_API_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Peticiones por ventana y por LLAVE en la API publica. 120/minuto son dos por
   * segundo sostenidos: de sobra para consultar el estado de una cartera de
   * paquetes y muy poco para servir de ariete.
   */
  PUBLIC_API_RATE_LIMIT: z.coerce.number().int().positive().default(120),
  PUBLIC_API_RATE_WINDOW: z
    .string()
    .default('1m')
    .refine(isValidDuration, {
      message: 'PUBLIC_API_RATE_WINDOW debe ser una duracion valida (p. ej. "1m", "30s").',
    }),
  /**
   * Peticiones por ventana y por IP contra los endpoints de credenciales (login,
   * registro, verificacion, olvido de contrasena). Es el punto pendiente de
   * docs/04 §7: sin esto, probar contrasenas sale gratis.
   *
   * Va por IP y no por correo a proposito: limitar por correo deja abierta la
   * pulverizacion (una contrasena comun contra mil cuentas) y ademas permite que
   * un tercero bloquee la cuenta de alguien fallando adrede.
   */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  AUTH_RATE_WINDOW: z
    .string()
    .default('5m')
    .refine(isValidDuration, {
      message: 'AUTH_RATE_WINDOW debe ser una duracion valida (p. ej. "5m", "15m").',
    }),
  /** Techo de llaves ACTIVAS por casillero. Ver `MAX_ACTIVE_API_KEYS`. */
  API_KEYS_MAX_ACTIVE: z.coerce.number().int().positive().max(20).default(MAX_ACTIVE_API_KEYS),

  // --- Almacen de archivos adjuntos (comprobantes de pago, fotos de entrega) ---
  /**
   * Bucket privado de S3 donde viven los adjuntos en AWS. ES EL INTERRUPTOR DEL
   * DRIVER: con un valor aqui, `core/storage.ts` habla con S3; sin el, escribe
   * en `UPLOADS_DIR`. No hay bandera aparte porque no existe un estado valido de
   * "S3 encendido sin bucket".
   */
  UPLOADS_BUCKET: optionalEnv(),
  /**
   * Directorio local donde se guardan los archivos subidos. Es el driver de
   * DESARROLLO: sirve para operar de punta a punta sin depender de la nube. En
   * un contenedor no vale, el filesystem es efimero (docs/12 §6.2).
   */
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
  MAIL_FROM: z.string().default('HS Global Services <no-reply@hsglobalcr.com>'),
  /**
   * Region de los servicios de AWS (SES y el bucket de adjuntos). Obligatoria en
   * cuanto se enciende cualquiera de los dos (ver superRefine). El SDK sabria
   * deducirla del metadata de la instancia, pero preferimos que este escrita:
   * un bucket en otra region falla en la primera subida, no al arrancar.
   */
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
  /**
   * UN SOLO interruptor con tres posiciones, igual que `HELGA_MODE`. Antes eran
   * dos booleanos (`ONVO_ENABLED` + `ONVO_SIMULATE`) y habia que cruzarlos con las
   * credenciales para saber que iba a pasar.
   *
   *   - `on`        — pasarela REAL: se cobra de verdad. Exige las cuatro
   *                   credenciales (ver el superRefine); sin ellas la API no
   *                   arranca.
   *   - `simulated` — pasarela de mentira: se ofrece el pago con tarjeta sin
   *                   llamar a Onvo ni tener credenciales. El cobro lo resuelve el
   *                   propio cliente desde el portal (aprobar / rechazar), asi que
   *                   el flujo entero (crear el intento, confirmarlo, ver el
   *                   tramite pagado) se recorre completo. PROHIBIDO en
   *                   produccion: daria por cobrado dinero que nadie pago. El
   *                   arranque falla ahi, no se degrada en silencio.
   *   - `off`       — no se ofrece tarjeta. El cliente paga por deposito bancario,
   *                   que es un flujo completo y no depende de terceros.
   *
   * QUE ENTORNO SE TOCA CON `on` lo decide el PREFIJO DE LA LLAVE, no este valor
   * ni la URL: las llaves `onvo_test_*` no tocan la red bancaria real y la URL
   * base es la misma para ambos entornos.
   *
   * Es exactamente el valor de `onvoMode` (abajo): lo que se lee en el .env es lo
   * que se compara en el codigo.
   */
  ONVO_MODE: z.enum(['off', 'simulated', 'on']).default('off'),
  // Las cuatro de abajo son obligatorias con ONVO_MODE=on, y se ignoran en los
  // otros dos modos (no se llama a nadie).
  ONVO_BASE_URL: optionalEnv(),
  ONVO_SECRET_KEY: optionalEnv(),
  ONVO_PUBLIC_KEY: optionalEnv(),
  /**
   * Lo que Onvo manda TAL CUAL en el header `X-Webhook-Secret` de cada webhook (no
   * es un HMAC del cuerpo). Es lo unico que distingue un cobro real de un POST
   * falso: sin el, `verifyWebhookSecret` rechaza TODO y ningun pago con tarjeta se
   * llega a confirmar nunca. Por eso es obligatorio en modo `on`: una pasarela
   * cobrando sin poder confirmar es peor que una pasarela apagada.
   */
  ONVO_WEBHOOK_SECRET: optionalEnv(),
  ONVO_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // --- Proveedor de casillero en Miami: Helga (docs/13 §5) ---
  /**
   * UN SOLO interruptor con tres posiciones, en vez de dos banderas booleanas
   * (antes `HELGA_ENABLED` + `HELGA_MOCK`, cuya combinacion "apagada pero
   * simulada" se leia como si Helga estuviera apagada cuando en realidad estaba
   * activa). Aqui no hay combinaciones imposibles: o se llama a Helga, o se
   * simula, o no se llama a nadie.
   *
   *   - `on`        — integracion REAL: se sale a la red contra Helga. Exige
   *                   TODAS las credenciales (ver el superRefine de abajo) y que
   *                   la IP del servidor este en la lista blanca del proveedor;
   *                   si no, todo responde 403.
   *   - `simulated` — proveedor de mentira en proceso (`helga.mock.ts`): responde
   *                   las cinco operaciones sin red ni credenciales. Es el modo de
   *                   desarrollo. PROHIBIDO en produccion (el arranque falla).
   *   - `off`       — no se llama a nadie: los casilleros quedan 'pending', las
   *                   prealertas no salen y el robot no agenda sus tareas de Helga.
   *
   * En desarrollo NO se usa `on`: la IP local no esta en la lista blanca y, peor,
   * el proveedor no tiene ambiente de pruebas, asi que cada registro de prueba
   * crearia un destinatario REAL en la cuenta de produccion.
   *
   * TODO(13): dejarlo en `on` en produccion cuando la IP fija del backend este en
   * la whitelist y las credenciales esten cargadas.
   *
   * Es exactamente el valor de `helgaMode` (abajo), que es lo que consulta el
   * codigo: lo que se lee en el .env es lo que se ve en el codigo.
   */
  HELGA_MODE: z.enum(['off', 'simulated', 'on']).default('off'),
  // La validez de URL se exige abajo, solo en modo `on`.
  HELGA_BASE_URL: optionalEnv(),
  HELGA_CLIENT_ID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  HELGA_CLIENT_SECRET: optionalEnv(),
  /**
   * TODAS las cuentas de casillero, en JSON, la principal PRIMERO. Es lo que se
   * usa en produccion; el orden es el contrato, no un detalle (ver
   * `helgaPrincipalAccount`).
   *
   * Va en una sola variable y no en un `HELGA_USERNAME_2`, `_3`... porque el
   * numero de cuentas cambia con el negocio y una lista numerada obliga a tocar
   * el esquema cada vez que abren un casillero nuevo.
   *
   *   [{"code":"SJO008835","name":"HS GLOBAL","username":"...","password":"...","clientId":7536}, ...]
   *
   * Cargarla con `infra/scripts/helga-enable.ps1`, que la escribe cifrada.
   */
  HELGA_ACCOUNTS: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const text = raw?.trim();
      if (!text || /^<.*>$/.test(text)) return undefined;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'HELGA_ACCOUNTS debe ser un JSON valido: un array de cuentas.',
        });
        return z.NEVER;
      }

      const result = z.array(HelgaAccountSchema).nonempty().safeParse(parsed);
      if (!result.success) {
        const detail = result.error.issues
          .map((issue) => `[${issue.path.join('.')}] ${issue.message}`)
          .join('; ');
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `HELGA_ACCOUNTS invalido: ${detail}`,
        });
        return z.NEVER;
      }

      return result.data;
    }),
  /**
   * Cuenta unica, forma antigua. Sigue viva para el desarrollo local y para no
   * romper un entorno que todavia no tenga `HELGA_ACCOUNTS`: si esa falta, estas
   * dos se convierten en la lista de una sola cuenta. Con las dos puestas manda
   * `HELGA_ACCOUNTS`.
   */
  HELGA_USERNAME: optionalEnv(),
  HELGA_PASSWORD: optionalEnv(),
  HELGA_APP_ID: optionalEnv(),
  // Origin registrado en la lista blanca; Helga responde 403 si no coincide.
  HELGA_ORIGIN: optionalEnv(),
  HELGA_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * Solo aplica con `HELGA_MODE=simulated`: cuanto tarda el paquete de mentira en
   * pasar de un estado del proveedor al siguiente. Son 8 pasos hasta el final del
   * tramo, asi que con "2m" el recorrido completo dura 16 minutos.
   *
   * Comparalo con `ROBOT_PROVIDER_SYNC_EVERY`: si el paso es MAS CORTO que el
   * intervalo, el paquete salta varios estados entre corridas y se ejercita el
   * avance paso a paso de `provider-sync` (el caso realista). Si es mas largo, se
   * ve un estado por corrida, que es comodo para mirar el timeline del portal.
   */
  HELGA_SIMULATED_STEP: z
    .string()
    .default('2m')
    .refine(isValidDuration, {
      message: 'HELGA_SIMULATED_STEP debe ser una duracion valida (p. ej. "30s", "2m", "1h").',
    }),

  /**
   * Interruptor de la pantalla "Enlace con Miami" del portal (el panel de
   * diagnostico de los casilleros que no quedaron `synced` con Helga).
   *
   * Es una bandera de PRESENTACION, no de integracion: no cambia como se habla
   * con el proveedor (eso es `HELGA_MODE`), solo si el Admin encuentra esa
   * entrada en el menu. Sirve para no mostrar una pantalla de diagnostico de
   * Helga mientras el enlace no se opera desde aqui.
   *
   * Apagada, el recurso deja de existir para el portal: no sale en el menu, la
   * URL /app/enlace-miami cae en la pantalla por defecto y los endpoints de
   * `/api/clients/provider-links` responden 403 (no se confia en el cliente).
   */
  MIAMI_LINK_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // --- Tasa de cambio de referencia: API de indicadores de Hacienda ---
  // Solo INFORMA el tipo de cambio del dia; la tasa que usa el sistema es la que
  // el administrador fija en Configuración, y ningun monto se guarda con este
  // valor. Por eso la integracion es opcional y apagarla no degrada ninguna
  // funcion: simplemente deja de verse la referencia.
  //
  // ES UN BOOLEANO, no un modo de tres posiciones como Helga y Onvo, y no tiene
  // credenciales que validar: la API es publica y anonima. Aqui la degradacion
  // silenciosa ES la funcionalidad (sin referencia, la tasa se decide igual);
  // alla no puede serlo, porque un casillero sin enlazar o un cobro sin
  // confirmar no se pueden dejar pasar con un aviso en consola.
  HACIENDA_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Endpoint del tipo de cambio del dolar. Lleva default porque es una URL
   * publica y fija: sin credenciales de por medio, `HACIENDA_ENABLED=true` basta
   * para que la integracion funcione. Queda en el .env solo para poder apuntarla
   * a otro lado sin tocar codigo.
   */
  HACIENDA_BASE_URL: z.string().url().default('https://api.hacienda.go.cr/indicadores/tc/dolar'),
  HACIENDA_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // --- Robot de tareas programadas (scheduler) ---
  // Todo lo del robot lleva el prefijo ROBOT_ y los intervalos terminan en
  // _EVERY: al mirar el .env se ve de un golpe que son del mismo modulo y que el
  // valor es "cada cuanto", no "cuanto dura".
  /**
   * Interruptor del robot: si esta apagado, NINGUNA tarea de fondo corre (ni las
   * de Helga ni las que se agreguen despues) y los intervalos de abajo no se
   * miran. En desarrollo va apagado por defecto: no queremos temporizadores
   * disparando llamadas a integraciones mientras se trabaja en local.
   *
   * OJO, son dos interruptores en serie: las tareas de Helga necesitan ademas que
   * `HELGA_MODE` NO sea `off`. Con el robot encendido y Helga en `off` el
   * scheduler no agenda nada y lo avisa por consola al arrancar.
   *
   * Con `HELGA_MODE=simulated` el robot SI debe estar encendido: es el que hace
   * avanzar los tramites simulados. Apagado, hay que disparar
   * POST /api/shipments/sync-provider a mano.
   */
  ROBOT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Los intervalos son duraciones legibles: aceptan cualquier unidad ("30m",
  // "2h", "1d", "90s", "1h30m"). El formato se valida aqui para fallar al
  // arrancar y no en la primera corrida, media hora despues.
  /** Preguntarle a Helga el estado de cada paquete y avanzar los tramites. */
  ROBOT_PROVIDER_SYNC_EVERY: z
    .string()
    .default('15m')
    .refine(isValidDuration, {
      message: 'ROBOT_PROVIDER_SYNC_EVERY debe ser una duracion valida (p. ej. "30m", "2h", "1d").',
    }),
  /**
   * Reintentar el enlace del casillero con Helga de los clientes que quedaron en
   * 'pending'/'failed' (el registro no bloquea si el proveedor falla).
   */
  ROBOT_LOCKER_LINK_RETRY_EVERY: z
    .string()
    .default('1h')
    .refine(isValidDuration, {
      message: 'ROBOT_LOCKER_LINK_RETRY_EVERY debe ser una duracion valida (p. ej. "1h", "30m").',
    }),
  /** Reenviar a Helga las prealertas 'pending'/'failed' cuyo casillero ya esta enlazado. */
  ROBOT_PREALERT_RETRY_EVERY: z
    .string()
    .default('30m')
    .refine(isValidDuration, {
      message: 'ROBOT_PREALERT_RETRY_EVERY debe ser una duracion valida (p. ej. "30m", "2h").',
    }),
  /**
   * Traer los paquetes creados directamente en Helga, que nosotros no conocemos
   * (flujo 2, docs/13 §3.3).
   *
   * OJO: la op. E solo lista paquetes en DIGITADO; en cuanto avanzan salen del
   * listado y se pierden para el robot (hay que cargarlos a mano). Este intervalo
   * tiene que ser MAS CORTO que lo que tarda tipicamente un paquete en pasar de
   * DIGITADO a AGRUPADA.
   */
  ROBOT_PACKAGE_DISCOVERY_EVERY: z
    .string()
    .default('15m')
    .refine(isValidDuration, {
      message: 'ROBOT_PACKAGE_DISCOVERY_EVERY debe ser una duracion valida (p. ej. "15m", "1h").',
    }),
}).superRefine((env, ctx) => {
  // OJO: la tasa de referencia (HACIENDA_*) NO se valida aqui a proposito. No
  // tiene credenciales que exigir (la API es publica) y su URL trae default, asi
  // que encenderla nunca puede tumbar el arranque.

  // Correo: con el interruptor encendido la region deja de ser opcional. Va ANTES
  // del early return de Helga, que solo mira su propia integracion.
  if (env.MAIL_ENABLED === true && !env.AWS_REGION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AWS_REGION'],
      message: 'AWS_REGION es obligatoria con MAIL_ENABLED=true (region de SES).',
    });
  }

  // Adjuntos en S3: sin region el SDK no sabe a que endpoint hablar.
  if (env.UPLOADS_BUCKET && !env.AWS_REGION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AWS_REGION'],
      message: 'AWS_REGION es obligatoria con UPLOADS_BUCKET (region del bucket de adjuntos).',
    });
  }

  // En produccion el disco local NO es un almacen: el filesystem del contenedor
  // se borra en cada despliegue, y ahi viven los comprobantes de deposito y las
  // fotos de entrega, que son la prueba de un pago y de una entrega. Igual que
  // con las pasarelas simuladas, esto no se degrada en silencio: no arranca.
  if (env.NODE_ENV === 'production' && !env.UPLOADS_BUCKET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['UPLOADS_BUCKET'],
      message:
        'UPLOADS_BUCKET es obligatoria con NODE_ENV=production: en disco local los adjuntos ' +
        'se pierden en cada despliegue.',
    });
  }

  /**
   * Exige las credenciales de una integracion que esta en modo `on`. Solo ese modo
   * sale a la red; en `simulated` y `off` no se llama a nadie, asi que no se valida
   * nada. Preferimos no arrancar a descubrir el hueco en el primer registro de un
   * cliente o en el primer cobro.
   */
  const requireCredentials = (mode: string, flag: string, keys: readonly string[]) => {
    if (mode !== 'on') return;
    for (const key of keys) {
      const value = env[key as keyof typeof env];
      if (value === undefined || value === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} es obligatoria con ${flag}=on.`,
        });
      }
    }
  };

  requireCredentials(env.HELGA_MODE, 'HELGA_MODE', [
    'HELGA_BASE_URL',
    'HELGA_CLIENT_ID',
    'HELGA_CLIENT_SECRET',
    'HELGA_ORIGIN',
  ]);

  // El login va aparte porque acepta dos formas: la lista de cuentas o el par
  // suelto de la forma antigua. Exigir `HELGA_USERNAME` sin mas rechazaria un
  // entorno perfectamente configurado con `HELGA_ACCOUNTS`.
  const hasAccounts = (env.HELGA_ACCOUNTS?.length ?? 0) > 0;
  const hasLegacyPair = Boolean(env.HELGA_USERNAME && env.HELGA_PASSWORD);
  // Si la lista venia puesta pero no paso la validacion, el error de arriba ya
  // dice exactamente que le falta. Repetir aqui "no hay ninguna cuenta" sumaria
  // un segundo mensaje que apunta a la misma causa y despista.
  const accountsWereProvided = Boolean(process.env.HELGA_ACCOUNTS?.trim());
  if (env.HELGA_MODE === 'on' && !hasAccounts && !hasLegacyPair && !accountsWereProvided) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['HELGA_ACCOUNTS'],
      message:
        'Con HELGA_MODE=on hace falta al menos una cuenta: HELGA_ACCOUNTS (la principal primero) ' +
        'o, en su defecto, HELGA_USERNAME y HELGA_PASSWORD.',
    });
  }

  // El webhook entra aqui: sin su secreto la pasarela cobra pero no puede
  // confirmar nada (ver el comentario de ONVO_WEBHOOK_SECRET).
  requireCredentials(env.ONVO_MODE, 'ONVO_MODE', [
    'ONVO_BASE_URL',
    'ONVO_SECRET_KEY',
    'ONVO_PUBLIC_KEY',
    'ONVO_WEBHOOK_SECRET',
  ]);

  // Con el modo `on` los endpoints SI tienen que ser URLs reales.
  for (const [mode, key] of [
    [env.HELGA_MODE, 'HELGA_BASE_URL'],
    [env.ONVO_MODE, 'ONVO_BASE_URL'],
  ] as const) {
    const value = env[key];
    if (mode !== 'on' || value === undefined) continue;
    if (!z.string().url().safeParse(value).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} debe ser una URL válida (reemplaza el placeholder del .env.example).`,
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

/**
 * En que modo puede cobrar el sistema con tarjeta. Es `ONVO_MODE` tal cual, sin
 * traducir: lo que se lee en el .env es lo que se compara en el codigo.
 *
 *   - `on`        — Onvo de verdad. Las credenciales estan garantizadas: el
 *                   arranque las exige (ver el superRefine).
 *   - `simulated` — pasarela de mentira para probar sin credenciales. Nunca en
 *                   produccion (el arranque lo impide justo abajo).
 *   - `off`       — no se ofrece tarjeta; el cliente paga por deposito bancario.
 */
export type OnvoMode = 'off' | 'simulated' | 'on';

export const onvoMode: OnvoMode = config.ONVO_MODE;

// Una pasarela simulada en produccion daria por cobrado dinero que nadie pago:
// los pagos con tarjeta se confirmarian solos. No se degrada a apagada en
// silencio, se rechaza el arranque, porque un despliegue con esto encendido es un
// error que hay que ver antes de recibir el primer pedido.
if (onvoMode === 'simulated' && isProd) {
  throw new Error(
    'Configuración de entorno inválida:\n  - ONVO_MODE=simulated: la pasarela simulada no ' +
      'puede usarse con NODE_ENV=production. Ponla en "on" y configura las credenciales ' +
      'reales de Onvo, o en "off" para cobrar solo por depósito bancario.',
  );
}

/**
 * True si el sistema puede cobrar con tarjeta HOY, de verdad o simulado. Es lo que
 * mira el modulo de pagos para ofrecer el medio; quien necesite distinguir el modo
 * (por ejemplo para no llamar a Onvo) usa `onvoMode`.
 */
export const onvoReady = onvoMode !== 'off';

if (onvoMode === 'simulated') {
  console.warn(
    '[config] Pasarela de pago SIMULADA (ONVO_MODE=simulated). Los pagos con tarjeta se ' +
      'confirman sin cobrar nada real. Solo para desarrollo y pruebas.',
  );
}

/**
 * Como habla el sistema con el proveedor de casillero. Es `HELGA_MODE` tal cual,
 * sin traducir: lo que se lee en el .env es lo que se compara en el codigo.
 *
 *   - `on`        — Helga de verdad, por red, con credenciales completas.
 *   - `simulated` — proveedor de mentira en proceso, para probar el flujo entero
 *                   sin red ni credenciales. Nunca en produccion.
 *   - `off`       — no se llama a nadie: los casilleros quedan 'pending', las
 *                   prealertas no salen y el robot no agenda sus tareas.
 *
 * Mismo contrato que `onvoMode`, a proposito: las dos integraciones se leen igual.
 */
export type HelgaMode = 'off' | 'simulated' | 'on';

export const helgaMode: HelgaMode = config.HELGA_MODE;

// Un proveedor simulado en produccion daria por enlazados casilleros que Helga no
// conoce y por prealertados paquetes que nadie espera en Miami. Igual que con la
// pasarela: se rechaza el arranque en vez de ignorarlo en silencio.
if (helgaMode === 'simulated' && isProd) {
  throw new Error(
    'Configuración de entorno inválida:\n  - HELGA_MODE=simulated: el proveedor simulado no ' +
      'puede usarse con NODE_ENV=production. Ponlo en "on" y configura las credenciales ' +
      'reales de Helga, o en "off" si todavía no hay integración.',
  );
}

/**
 * Las cuentas de casillero del proveedor, EN ORDEN: la principal primero.
 *
 * Sale de `HELGA_ACCOUNTS` y, si esa no esta, del par suelto de la forma antigua
 * convertido en una lista de uno. Vacia solo cuando la integracion esta apagada.
 */
export const helgaAccounts: readonly HelgaAccount[] = (() => {
  if (config.HELGA_ACCOUNTS?.length) return config.HELGA_ACCOUNTS;
  if (config.HELGA_USERNAME && config.HELGA_PASSWORD) {
    return [
      {
        code: 'principal',
        name: 'Cuenta principal',
        username: config.HELGA_USERNAME,
        password: config.HELGA_PASSWORD,
        clientId: null,
      },
    ];
  }
  return [];
})();

/**
 * La cuenta bajo la que opera el sistema HOY. Es la PRIMERA de la lista, y esa
 * es toda la regla: mientras no exista un criterio de negocio para repartir los
 * clientes entre casilleros, todo cuelga de esta.
 *
 * `null` con la integracion apagada; con `HELGA_MODE=on` el arranque ya garantizo
 * que hay al menos una.
 */
export const helgaPrincipalAccount: HelgaAccount | null = helgaAccounts[0] ?? null;

if (helgaMode === 'on' && helgaAccounts.length > 1) {
  const otras = helgaAccounts
    .slice(1)
    .map((cuenta) => cuenta.code)
    .join(', ');
  console.info(
    `[config] Helga: ${helgaAccounts.length} cuentas cargadas. Principal ${helgaPrincipalAccount?.code} ` +
      `(${helgaPrincipalAccount?.name}); en reserva: ${otras}.`,
  );
}

/** Ventana del limitador de la API publica, en milisegundos. */
export const publicApiRateWindowMs = parseDuration(config.PUBLIC_API_RATE_WINDOW);

/** Ventana del limitador de los endpoints de credenciales, en milisegundos. */
export const authRateWindowMs = parseDuration(config.AUTH_RATE_WINDOW);

/** Duracion de un paso de la linea de tiempo simulada, en milisegundos. */
export const helgaSimulatedStepMs = parseDuration(config.HELGA_SIMULATED_STEP);

if (helgaMode === 'simulated') {
  console.warn(
    `[config] Proveedor Helga SIMULADO (HELGA_MODE=simulated), paso de ${config.HELGA_SIMULATED_STEP}. ` +
      'Ninguna llamada sale a la red y los ids del proveedor son inventados. ' +
      'Panel de control en /api/dev/helga. Solo para desarrollo y pruebas.',
  );
}

/**
 * Si el portal ofrece la pantalla "Enlace con Miami". Es `MIAMI_LINK_ENABLED`
 * tal cual: lo que se lee en el .env es lo que se compara en el codigo. Lo
 * consultan `GET /api/auth/me` (para armar el menu) y las rutas de
 * `provider-links` (para no servir la pantalla por URL con la bandera apagada).
 */
export const miamiLinkEnabled = config.MIAMI_LINK_ENABLED;

// La tasa de referencia NO tiene un booleano derivado aqui a proposito. Antes
// existia `bccrReady` (= bandera encendida Y credenciales cargadas) porque el
// BCCR exigia una suscripcion con nombre, correo y token, y "encendido pero sin
// credenciales" era un estado real. La API de Hacienda es publica y anonima:
// `HACIENDA_ENABLED` es por si solo el interruptor efectivo, y el modulo que la
// consulta lo lee directo.
