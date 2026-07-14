/**
 * Logica de autenticacion. Frontera real de seguridad (docs/04): hashing
 * argon2id, verificacion de codigo con expiracion/intentos, y sesion en cookie
 * con revocacion inmediata.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { Principal, Role, UserStatus, principalForRole } from '@courier/shared';
import type { AcceptInviteInput, LoginInput, RegisterInput, Session, VerifyInput } from '@courier/shared';
import { config, isProd } from '../../core/config';
import { AuthErrors } from '../../core/errors';
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

export const authService = {
  /** Alta de customer (autoregistro). Crea el usuario + su casillero y emite el codigo. */
  async register(input: RegisterInput): Promise<{ userId: string }> {
    const existing = await authRepo.findUserByEmail(input.email);
    if (existing) throw AuthErrors.emailInUse();

    const passwordHash = await hash(input.password);
    const user = await authRepo.insertUser({
      email: input.email,
      passwordHash,
      principal: Principal.Client,
      role: Role.Client,
      name: input.name,
      status: UserStatus.Activo,
    });

    // El casillero (HS-####) se asigna ya; el login queda bloqueado hasta verificar.
    const code = await authRepo.nextClientCode();
    await authRepo.insertClient({ userId: user.id, code, city: input.city ?? null });

    await this.issueVerificationCode(user.id, user.email);
    return { userId: user.id };
  },

  /** Genera y guarda (hasheado) un codigo de 6 digitos; "envia" por email. */
  async issueVerificationCode(userId: string, email: string): Promise<void> {
    const code = newVerificationCode();
    const expiresAt = new Date(Date.now() + config.EMAIL_CODE_TTL_MINUTES * 60_000);
    await authRepo.deleteVerifications(userId); // invalida codigos anteriores
    await authRepo.insertVerification({ userId, codeHash: sha256(code), expiresAt });

    // TODO(09/email): integrar envio real. En dev lo mostramos por consola.
    if (!isProd) console.log(`[auth] código de verificación para ${email}: ${code}`);
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
  async issueInvitation(userId: string, email: string): Promise<void> {
    const token = newToken();
    const expiresAt = new Date(Date.now() + config.INVITE_TTL_HOURS * 3_600_000);
    await authRepo.insertPasswordReset({ userId, tokenHash: sha256(token), purpose: 'invite', expiresAt });

    // TODO(09/email): enviar el enlace real (WEB_ORIGIN/invitacion?token=...). En dev lo mostramos.
    if (!isProd) console.log(`[auth] invitación para ${email}: token=${token}`);
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
      if (client) session.clientCode = client.code;
    }
    // Consistencia defensiva: el principal siempre concuerda con el rol.
    session.principal = principalForRole(user.role);
    return session;
  },
};
