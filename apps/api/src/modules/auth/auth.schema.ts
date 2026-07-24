/**
 * Tablas Drizzle del modulo auth (docs/02b §4.1-4.4).
 * Una sola tabla de identidad `users` para customer y staff; `clients` es el
 * perfil 1:1 del casillero. Los enums salen de @courier/shared (fuente unica).
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  CLIENT_REVIEW_STATUS_VALUES,
  ClientReviewStatus,
  HELGA_SYNC_STATUS_VALUES,
  HelgaSyncStatus,
  PRINCIPAL_VALUES,
  ROLE_VALUES,
  USER_STATUS_VALUES,
  UserStatus,
} from '@courier/shared';
import { currencyEnum } from '../../core/currency.schema';
import { clientRates } from '../tariffs/tariffs.schema';

export const principalEnum = pgEnum('principal', PRINCIPAL_VALUES);
export const roleEnum = pgEnum('role', ROLE_VALUES);
export const userStatusEnum = pgEnum('user_status', USER_STATUS_VALUES);
export const clientReviewStatusEnum = pgEnum('client_review_status', CLIENT_REVIEW_STATUS_VALUES);
export const helgaSyncStatusEnum = pgEnum('helga_sync_status', HELGA_SYNC_STATUS_VALUES);

/** Secuencia del codigo de casillero: HS-1042, HS-1043, ... */
export const clientCodeSeq = pgSequence('hs_client_code_seq', { startWith: 1042, increment: 1 });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    principal: principalEnum('principal').notNull(),
    role: roleEnum('role').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    status: userStatusEnum('status').notNull().default(UserStatus.Activo),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Coherencia principal <-> role (docs/02b §4.1). La BD lo garantiza, no la app.
    check(
      'users_principal_role_coherent',
      sql`(${t.principal} = 'client' AND ${t.role} = 'client') OR (${t.principal} = 'staff' AND ${t.role} <> 'client')`,
    ),
  ],
);

/**
 * Perfil de casillero (1:1 con users). Solo para principal = 'client'.
 * Guarda el contacto y la direccion de entrega REALES del cliente: son
 * propiedad de HS Global y la fuente de verdad de la operacion. Hacia el
 * proveedor nunca viajan (docs/13 §3.6); alli va la direccion fija de
 * consolidacion y un correo derivado.
 */
export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  code: text('code').notNull().unique(),
  /** Cedula normalizada a solo digitos (@courier/shared: idNumberSchema). */
  idNumber: text('id_number').notNull().unique(),
  // Direccion de entrega en Costa Rica: codigos del catalogo territorial
  // compartido (no FKs: el catalogo es codigo, no tabla) + otras senas.
  provinceCode: text('province_code').notNull(),
  cantonCode: text('canton_code').notNull(),
  districtCode: text('district_code').notNull(),
  addressLine: text('address_line').notNull(),
  /** Todo casillero nace 'nuevo' para que un admin lo revise despues. */
  reviewStatus: clientReviewStatusEnum('review_status').notNull().default(ClientReviewStatus.Nuevo),
  /**
   * Tarifa asignada. Al registrarse se asigna la tarifa por defecto del sistema.
   * `set null` al borrar la tarifa: el servicio de tarifas ya impide borrar la
   * default, y un casillero sin tarifa es preferible a perder el casillero.
   */
  clientRateId: uuid('client_rate_id').references(() => clientRates.id, { onDelete: 'set null' }),
  /**
   * Limite de credito (Parte 3, "Editar Cliente"). Techo de politica comercial,
   * no un monto transaccional: lleva moneda explicita (regla M2) pero NO tasa de
   * cambio, igual que `client_rates.price_per_kg`. Ver money-rules.config.json.
   * `null` = sin limite definido, distinto de 0 (no fiarle nada).
   */
  creditLimit: doublePrecision('credit_limit'),
  creditLimitCurrency: currencyEnum('credit_limit_currency'),
  /** Enlace con el proveedor: id del cliente/destinatario en Helga (docs/13). */
  helgaClientId: text('helga_client_id').unique(),
  /**
   * `sub_casillero` que asigna Helga (p. ej. `SJO008835S033`): la direccion con
   * la que el cliente recibe en Miami. Es lo que debe ver en el portal y usar al
   * comprar; sin el, su paquete llega a la cuenta de HS Global sin dueño.
   */
  helgaSubLocker: text('helga_sub_locker'),
  helgaSyncedAt: timestamp('helga_synced_at', { withTimezone: true }),
  /**
   * Estado del enlace con el proveedor. Nace 'pending': el casillero existe de
   * nuestro lado aunque aun no este en Helga. La reconciliacion lo llevara a
   * 'synced' (o 'failed' si el proveedor rechaza). Gobierna el acceso del
   * cliente mientras la integracion este encendida (ver auth.service login).
   */
  helgaSyncStatus: helgaSyncStatusEnum('helga_sync_status')
    .notNull()
    .default(HelgaSyncStatus.Pending),
  /** Intentos de enlace ya realizados; 0 si la integracion estaba apagada. */
  helgaSyncAttempts: integer('helga_sync_attempts').notNull().default(0),
  /** Ultimo error del proveedor al intentar enlazar; para diagnostico del robot. */
  helgaLastError: text('helga_last_error'),
  memberSince: date('member_since'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Sesion por cookie httpOnly; store en Postgres => revocacion inmediata. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** Codigo de verificacion de email: aleatorio, hasheado, con expiracion. */
export const emailVerifications = pgTable(
  'email_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_verifications_user_idx').on(t.userId)],
);

/**
 * Token para fijar/restablecer contrasena por correo. Cubre dos propositos
 * (docs/roles.md §1.3.4): 'invite' (alta de staff) y 'reset' (olvido). El token
 * viaja al correo; en BD solo su hash. Un uso, con expiracion.
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    purpose: text('purpose').notNull(), // 'invite' | 'reset'
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('password_resets_user_idx').on(t.userId)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
