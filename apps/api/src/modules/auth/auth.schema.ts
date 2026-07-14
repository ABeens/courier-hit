/**
 * Tablas Drizzle del modulo auth (docs/02b §4.1-4.4).
 * Una sola tabla de identidad `users` para customer y staff; `clients` es el
 * perfil 1:1 del casillero. Los enums salen de @courier/shared (fuente unica).
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { PRINCIPAL_VALUES, ROLE_VALUES, USER_STATUS_VALUES, UserStatus } from '@courier/shared';

export const principalEnum = pgEnum('principal', PRINCIPAL_VALUES);
export const roleEnum = pgEnum('role', ROLE_VALUES);
export const userStatusEnum = pgEnum('user_status', USER_STATUS_VALUES);

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

/** Perfil de casillero (1:1 con users). Solo para principal = 'client'. */
export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  code: text('code').notNull().unique(),
  city: text('city'),
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
