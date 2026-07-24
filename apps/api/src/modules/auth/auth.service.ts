/**
 * Logica de autenticacion. Frontera real de seguridad (docs/04): hashing
 * argon2id, verificacion de codigo con expiracion/intentos, y sesion en cookie
 * con revocacion inmediata.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import {
  ClientReviewStatus,
  HelgaSyncStatus,
  Principal,
  Role,
  UserStatus,
  principalForRole,
} from '@courier/shared';
import type { AcceptInviteInput, LoginInput, RegisterInput, Session, VerifyInput } from '@courier/shared';
import { config, isProd } from '../../core/config';
import { AuthErrors } from '../../core/errors';
import { mailer } from '../../core/mailer';
import type { HelgaRecipient } from '../../integrations/helga/helga.client';
import { createHelgaRecipient, isHelgaEnabled } from '../../integrations/helga/helga.client';
import { tariffsRepo } from '../tariffs/tariffs.repo';
import { authRepo } from './auth.repo';
import type { UserRow } from './auth.schema';

// @node-rs/argon2 usa Argon2id por defecto (docs/04 exige argon2id).

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

function newVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

type SessionMeta = { userAgent?: string | undefined; ip?: string | undefined };

/** Resumen de una corrida de reconciliacion (para el log del robot). */
export interface ReconcileReport {
  checked: number;
  synced: number;
  failed: number;
}

/**
 * Cuantos casilleros reintenta enlazar el robot por corrida. Acota el trabajo de
 * cada pasada (y las llamadas al proveedor); el resto del backlog se drena en las
 * corridas siguientes. Tunear si el rezago inicial es grande.
 */
const LINK_RECONCILE_BATCH = 50;

export const authService = {
  /**
   * Alta de customer (autoregistro). Crea el usuario y su casillero con la
   * tarifa por defecto, intenta enlazarlo con el proveedor y emite el codigo de
   * verificacion.
   *
   * El enlace con Helga NO es bloqueante (cambio deliberado): el casillero
   * nace y persiste aunque el proveedor falle o este apagado, marcado con
   * `helgaSyncStatus` (pending/failed). La reconciliacion lo reintentara. La
   * puerta de negocio "no queremos clientes de nuestro lado y no del suyo" se
   * mueve al login: mientras la integracion este encendida, el cliente no
   * ingresa hasta quedar `synced` (ver `login`).
   *
   * Lo que si sigue siendo bloqueante y va ANTES de escribir: unicidad de
   * email/cedula y existencia de tarifa por defecto.
   */
  async register(input: RegisterInput): Promise<{ userId: string; code: string }> {
    const existing = await authRepo.findUserByEmail(input.email);
    if (existing) throw AuthErrors.emailInUse();

    const sameIdNumber = await authRepo.findClientByIdNumber(input.idNumber);
    if (sameIdNumber) throw AuthErrors.idNumberInUse();

    // Todo casillero nuevo entra con la tarifa por defecto del sistema.
    const defaultRate = await tariffsRepo.findDefault();
    if (!defaultRate) throw AuthErrors.defaultRateMissing();

    // Intento de enlace con el proveedor. Nunca lanza: el resultado decide el
    // estado del casillero, no si el registro procede.
    const link = await this.linkWithProvider({
      name: input.name,
      idNumber: input.idNumber,
      email: input.email,
    });

    const passwordHash = await hash(input.password);
    const user = await authRepo.insertUser({
      email: input.email,
      passwordHash,
      principal: Principal.Client,
      role: Role.Client,
      name: input.name,
      phone: input.phone,
      status: UserStatus.Activo,
    });

    // El casillero (HS-####) se asigna ya; el login queda bloqueado hasta
    // verificar el correo y, con Helga encendido, hasta quedar `synced`.
    const code = await authRepo.nextClientCode();
    await authRepo.insertClient({
      userId: user.id,
      code,
      idNumber: input.idNumber,
      provinceCode: input.provinceCode,
      cantonCode: input.cantonCode,
      districtCode: input.districtCode,
      addressLine: input.addressLine,
      // Nace 'nuevo' (valor por defecto de la columna) para que un admin lo revise.
      reviewStatus: ClientReviewStatus.Nuevo,
      clientRateId: defaultRate.id,
      helgaClientId: link.recipient?.id ?? null,
      helgaSubLocker: link.recipient?.subLocker ?? null,
      helgaSyncedAt: link.recipient ? new Date() : null,
      helgaSyncStatus: link.status,
      helgaSyncAttempts: link.attempts,
      helgaLastError: link.error,
    });

    await this.issueVerificationCode(user.id, user.email);
    return { userId: user.id, code };
  },

  /**
   * Intenta enlazar el casillero con Helga sin lanzar nunca. Devuelve el
   * resultado (destinatario + estado de sincronizacion) para que el llamador lo
   * persista:
   *
   * - Integracion apagada: `pending`, 0 intentos (en local no se enciende para
   *   no crear destinatarios reales en cada prueba; el enlace lo hara la
   *   reconciliacion cuando Helga este disponible).
   * - Exito: `synced`.
   * - El proveedor rechaza o no responde: `failed`, con el mensaje del error.
   */
  async linkWithProvider(input: {
    name: string;
    idNumber: string;
    email: string;
  }): Promise<{
    recipient: HelgaRecipient | null;
    status: HelgaSyncStatus;
    attempts: number;
    error: string | null;
  }> {
    const { email } = input;
    if (!isHelgaEnabled()) {
      // TODO(13): encender HELGA_ENABLED cuando la IP fija del backend este en
      // la whitelist. Mientras, el casillero queda 'pending' y la reconciliacion
      // enlazara los creados en este periodo cuando la integracion se encienda.
      if (!isProd) console.log(`[auth] Helga deshabilitado: casillero de ${email} queda pending.`);
      return { recipient: null, status: HelgaSyncStatus.Pending, attempts: 0, error: null };
    }
    try {
      const recipient = await createHelgaRecipient({
        fullName: input.name,
        idNumber: input.idNumber,
        realEmail: email,
      });
      return { recipient, status: HelgaSyncStatus.Synced, attempts: 1, error: null };
    } catch (err) {
      // No aborta el registro: se guarda el motivo y la reconciliacion reintenta.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[auth] Helga rechazó el alta de ${email}:`, err);
      return { recipient: null, status: HelgaSyncStatus.Failed, attempts: 1, error: message };
    }
  },

  /**
   * Tarea del robot: reintenta enlazar con el proveedor los casilleros que
   * quedaron sin sincronizar ('pending' o 'failed') y actualiza la bandera al
   * resultado. Reusa `linkWithProvider` (la misma llamada del registro) y sella
   * el resultado en el casillero: en exito lo deja 'synced' con su `helgaClientId`
   * y sub-casillero; en fallo suma un intento y guarda el motivo para diagnostico.
   *
   * Nunca lanza por un casillero: un fallo con uno no debe frenar los demas. El
   * scheduler ya la corre bajo un advisory lock, asi que no hay dos reconciliaciones
   * a la vez y el contador de intentos no compite.
   */
  async reconcileProviderLinks(): Promise<ReconcileReport> {
    const report: ReconcileReport = { checked: 0, synced: 0, failed: 0 };
    if (!isHelgaEnabled()) return report;

    const pending = await authRepo.findClientsToReconcile(LINK_RECONCILE_BATCH);
    for (const client of pending) {
      report.checked += 1;
      const link = await this.linkWithProvider({
        name: client.name,
        idNumber: client.idNumber,
        email: client.email,
      });

      await authRepo.updateClientHelgaSync(client.id, {
        // En fallo `recipient` es null: dejamos los campos de enlace como estaban
        // (undefined = Drizzle no toca la columna); solo se sellan estado, intento
        // y error.
        helgaClientId: link.recipient?.id ?? undefined,
        helgaSubLocker: link.recipient?.subLocker ?? undefined,
        helgaSyncedAt: link.recipient ? new Date() : undefined,
        helgaSyncStatus: link.status,
        helgaSyncAttempts: client.attempts + 1,
        helgaLastError: link.error,
      });

      if (link.status === HelgaSyncStatus.Synced) report.synced += 1;
      else report.failed += 1;
    }
    return report;
  },

  /** Genera y guarda (hasheado) un codigo de 6 digitos; "envia" por email. */
  async issueVerificationCode(userId: string, email: string): Promise<void> {
    const code = newVerificationCode();
    const expiresAt = new Date(Date.now() + config.EMAIL_CODE_TTL_MINUTES * 60_000);
    await authRepo.deleteVerifications(userId); // invalida codigos anteriores
    await authRepo.insertVerification({ userId, codeHash: sha256(code), expiresAt });

    await mailer.send({
      to: email,
      subject: 'Verifica tu correo — HS Global Courier',
      body: [
        'Bienvenido(a) a HS Global Courier.',
        '',
        `Tu código de verificación es: ${code}`,
        '',
        `El código vence en ${config.EMAIL_CODE_TTL_MINUTES} minutos.`,
        'Si no creaste esta cuenta, ignora este mensaje.',
        '',
        'Saludos cordiales,',
        'Equipo HS Global',
      ].join('\n'),
    });
  },

  /** Confirma el codigo y activa la cuenta (sella email_verified_at). */
  async verify(input: VerifyInput): Promise<{ verified: true }> {
    const user = await authRepo.findUserByEmail(input.email);
    if (!user) throw AuthErrors.invalidCode();
    if (user.emailVerifiedAt) return { verified: true }; // idempotente

    const v = await authRepo.latestVerification(user.id);
    if (!v) throw AuthErrors.invalidCode();
    if (v.expiresAt.getTime() < Date.now()) throw AuthErrors.invalidCode();
    if (v.attempts >= config.EMAIL_CODE_MAX_ATTEMPTS) throw AuthErrors.invalidCode();
    if (sha256(input.code) !== v.codeHash) {
      await authRepo.bumpVerificationAttempts(v.id);
      throw AuthErrors.invalidCode();
    }

    await authRepo.markEmailVerified(user.id);
    await authRepo.deleteVerifications(user.id);
    return { verified: true };
  },

  /**
   * Emite un token de invitacion para que un staff recien creado fije su
   * contrasena (docs/roles.md §1.3.4). El admin nunca ve ni digita la clave.
   */
  async issueInvitation(userId: string, email: string): Promise<string | null> {
    const token = newToken();
    const expiresAt = new Date(Date.now() + config.INVITE_TTL_HOURS * 3_600_000);
    await authRepo.insertPasswordReset({ userId, tokenHash: sha256(token), purpose: 'invite', expiresAt });

    const link = `${config.WEB_ORIGIN}/invitacion?token=${token}`;
    await mailer.send({
      to: email,
      subject: 'Tu acceso al panel de HS Global Courier',
      body: [
        'Se creó una cuenta para ti en el panel de HS Global Courier.',
        '',
        'Define tu contraseña en el siguiente enlace:',
        link,
        '',
        `El enlace vence en ${config.INVITE_TTL_HOURS} horas.`,
        '',
        'Saludos cordiales,',
        'Equipo HS Global',
      ].join('\n'),
    });

    // En desarrollo se devuelve para mostrarlo en la UI y no depender de leer el
    // log. En produccion NUNCA sale del servidor: el token viaja solo por correo.
    return isProd ? null : link;
  },

  /** Fija la contrasena desde un token de invitacion/reset y deja la cuenta lista. */
  async acceptInvite(input: AcceptInviteInput): Promise<{ ok: true }> {
    const reset = await authRepo.findValidPasswordReset(sha256(input.token));
    if (!reset) throw AuthErrors.invalidToken();

    const passwordHash = await hash(input.password);
    await authRepo.setPassword(reset.userId, passwordHash);
    await authRepo.markPasswordResetUsed(reset.id);
    // Aceptar la invitacion desde el correo prueba la titularidad del email.
    await authRepo.markEmailVerified(reset.userId);
    return { ok: true };
  },

  /** Email+contraseña => crea sesion. El principal/rol salen del usuario, no del body. */
  async login(input: LoginInput, meta: SessionMeta): Promise<{ session: Session; expiresAt: Date }> {
    const user = await authRepo.findUserByEmail(input.email);
    if (!user) throw AuthErrors.invalidCredentials();
    if (user.status !== UserStatus.Activo) throw AuthErrors.userInactive();

    const ok = await verify(user.passwordHash, input.password).catch(() => false);
    if (!ok) throw AuthErrors.invalidCredentials();
    if (!user.emailVerifiedAt) throw AuthErrors.emailNotVerified();

    // Puerta del proveedor: con Helga encendido, un customer no ingresa hasta
    // que su casillero quede `synced`. Con la integracion apagada no hay
    // verificacion posible, asi que no se bloquea (dev y periodo pre-whitelist).
    if (user.principal === Principal.Client && isHelgaEnabled()) {
      const client = await authRepo.getClientByUserId(user.id);
      if (client && client.helgaSyncStatus !== HelgaSyncStatus.Synced) {
        throw AuthErrors.accountPendingVerification();
      }
    }

    return this.createSession(user, meta);
  },

  async logout(sessionId: string): Promise<void> {
    await authRepo.deleteSession(sessionId);
  },

  /** Resuelve la sesion en cada request; revoca si el usuario ya no esta activo. */
  async resolveSession(sessionId: string): Promise<Session | null> {
    const s = await authRepo.findSession(sessionId);
    if (!s) return null;
    if (s.expiresAt.getTime() < Date.now()) {
      await authRepo.deleteSession(sessionId);
      return null;
    }
    const user = await authRepo.findUserById(s.userId);
    if (!user || user.status !== UserStatus.Activo) {
      // Usuario deshabilitado/eliminado => revocacion inmediata (roles.md §1.3.8).
      await authRepo.deleteSession(sessionId);
      return null;
    }
    return this.buildSession(sessionId, user);
  },

  async createSession(user: UserRow, meta: SessionMeta): Promise<{ session: Session; expiresAt: Date }> {
    const id = newSessionId();
    const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3_600_000);
    await authRepo.insertSession({
      id,
      userId: user.id,
      expiresAt,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    });
    return { session: await this.buildSession(id, user), expiresAt };
  },

  /** Arma el objeto Session del dominio; agrega clientCode si es customer. */
  async buildSession(sessionId: string, user: UserRow): Promise<Session> {
    const session: Session = {
      sessionId,
      userId: user.id,
      principal: user.principal,
      role: user.role,
    };
    if (user.principal === Principal.Client) {
      const client = await authRepo.getClientByUserId(user.id);
      if (client) {
        session.clientId = client.id;
        session.clientCode = client.code;
      }
    }
    // Consistencia defensiva: el principal siempre concuerda con el rol.
    session.principal = principalForRole(user.role);
    return session;
  },
};
