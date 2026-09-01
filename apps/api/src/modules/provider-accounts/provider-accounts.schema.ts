/**
 * Tabla Drizzle de las cuentas EXCLUSIVAS del proveedor de casillero (Helga).
 *
 * Aqui NO esta la cuenta principal de HS Global: esa vive en la configuracion del
 * despliegue (`HELGA_ACCOUNTS`, docs/13 §1.1b) y no se administra desde el portal.
 * La razon es de riesgo, no de gusto: la principal es la que atiende a todos los
 * clientes del landing, y una edicion mal hecha desde una pantalla dejaria sin
 * casillero a todo el mundo. Lo que se da de alta aqui son cuentas de terceros,
 * cada una con un unico dueno, cuyo peor fallo afecta a ese dueno y a nadie mas.
 *
 * EL ENLACE VA EN ESTA TABLA, no en `clients`. `consolidated_client_id` es UNIQUE:
 * una cuenta exclusiva pertenece a un solo cliente consolidado y un cliente
 * consolidado tiene una sola cuenta (relacion 1 a 1). Ponerlo aqui evita el
 * import circular entre este modulo y `auth.schema` (donde vive `clients`) y deja
 * el dato donde se consulta: el recorrido de importacion parte de la cuenta.
 *
 * LOS SECRETOS VAN CIFRADOS, no hasheados: el robot tiene que volver a leerlos
 * para pedir el token en cada corrida (ver `core/secrets.ts`).
 */
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { clients, users } from '../auth/auth.schema';

export const providerAccounts = pgTable(
  'provider_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Codigo de casillero del proveedor (`SJO009623`). Identifica la cuenta ante
     * Helga y es lo que se sella como origen en cada paquete importado, asi que
     * es la llave natural de la fila.
     */
    code: text('code').notNull(),
    /** A nombre de quien esta la cuenta del lado del proveedor ("ZUCA"). */
    name: text('name').notNull(),
    /** Usuario o correo del grant `password` de esa cuenta. */
    username: text('username').notNull(),
    /** Contrasena del grant, cifrada (AES-256-GCM). Nunca sale del backend. */
    passwordEncrypted: text('password_encrypted').notNull(),
    /**
     * Credenciales de APLICACION propias, cifrado el secreto. Nulas = la cuenta
     * usa las del despliegue, que es el caso normal (`client_id` y
     * `client_secret` son de la app y se comparten entre casilleros).
     */
    oauthClientId: text('oauth_client_id'),
    oauthClientSecretEncrypted: text('oauth_client_secret_encrypted'),
    appId: text('app_id'),
    /**
     * `cliente_id` de la cuenta dentro de Helga (op. D). Una cuenta exclusiva no
     * da de alta destinatarios desde aqui, asi que puede quedarse en `null`; se
     * guarda porque es el unico dato que permitiria usarla para eso mas adelante.
     */
    providerCustomerId: integer('provider_customer_id'),
    /**
     * El cliente consolidado al que se atribuye TODA la paqueteria de la cuenta,
     * venga del sub-casillero que venga.
     *
     * `restrict` al borrar el cliente, y no `cascade` ni `set null`: una cuenta
     * huerfana seguiria importando paquetes sin dueno a quien atribuirselos, y
     * una cuenta borrada en cascada se llevaria por delante credenciales que
     * nadie mas tiene. Si de verdad hay que quitar al cliente, primero se apaga
     * la cuenta.
     */
    consolidatedClientId: uuid('consolidated_client_id').references(() => clients.id, {
      onDelete: 'restrict',
    }),
    /**
     * Si la cuenta entra en el recorrido de importacion. Apagarla es la forma de
     * sacar una cuenta de servicio sin borrar su historial ni su enlace: un
     * paquete ya importado sigue diciendo de donde vino.
     */
    active: boolean('active').notNull().default(true),
    /** Cuando corrio por ultima vez la importacion sobre esta cuenta. */
    lastImportAt: timestamp('last_import_at', { withTimezone: true }),
    /**
     * Motivo del ultimo fallo de importacion, o `null` si la ultima corrida fue
     * bien. Es lo que convierte "no llegan paquetes" en un diagnostico: casi
     * siempre son credenciales caducadas o una IP fuera de la lista blanca.
     */
    lastImportError: text('last_import_error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * Un codigo de casillero, una cuenta. Dos filas con el mismo codigo harian
     * ambiguo el origen sellado en cada paquete, que es justamente el dato con el
     * que despues se decide con que token consultarlo.
     */
    uniqueIndex('provider_accounts_code_idx').on(t.code),
    /**
     * La relacion 1 a 1 con el cliente consolidado, impuesta por la base y no por
     * el servicio: dos cuentas apuntando al mismo cliente le mezclarian la
     * paqueteria de dos empresas distintas.
     */
    uniqueIndex('provider_accounts_client_idx').on(t.consolidatedClientId),
  ],
);

export type ProviderAccountRow = typeof providerAccounts.$inferSelect;
export type NewProviderAccountRow = typeof providerAccounts.$inferInsert;
