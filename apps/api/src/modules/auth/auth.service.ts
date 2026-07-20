/**
 * Logica de autenticacion. Frontera real de seguridad (docs/04): hashing
 * argon2id, verificacion de codigo con expiracion/intentos, y sesion en cookie
 * con revocacion inmediata.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { ClientReviewStatus, Principal, Role, UserStatus, principalForRole } from '@courier/shared';
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

export const authService = {
  /**
   * Alta de customer (autoregistro). Crea el usuario, lo registra ante el
   * proveedor, crea su casillero con la tarifa por defecto y emite el codigo de
   * verificacion.
   *
   * Orden deliberado: todo lo que puede fallar (unicidad, tarifa por defecto,
   * proveedor) se resuelve ANTES de escribir. El registro ante Helga es
   * bloqueante por decision de negocio: no queremos clientes que existan de
   * nuestro lado y no del suyo.
   */
  async register(input: RegisterInput): Promise<{ userId: string; code: string }> {
    const existing = await authRepo.findUserByEmail(input.email);
    if (existing) throw AuthErrors.emailInUse();

    const sameIdNumber = await authRepo.findClientByIdNumber(input.idNumber);
    if (sameIdNumber) throw AuthErrors.idNumberInUse();

    // Todo casillero nuevo entra con la tarifa por defecto del sistema.
    const defaultRate = await tariffsRepo.findDefault();
    if (!defaultRate) throw AuthErrors.defaultRateMissing();

    // Se registra ante el proveedor primero: si falla, no dejamos rastro en
    // nuestra BD y el usuario puede reintentar con los mismos datos.
    const helga = await this.registerWithProvider({
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

    // El casillero (HS-####) se asigna ya; el login queda bloqueado hasta verificar.
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
      helgaClientId: helga?.id ?? null,
      helgaSubLocker: helga?.subLocker ?? null,
      helgaSyncedAt: helga ? new Date() : null,
    });

    await this.issueVerificationCode(user.id, user.email);
    return { userId: user.id, code };
  },

  /**
   * Registra el casillero ante Helga y devuelve su id y su sub-casillero, o
   * `null` si la integracion esta apagada (en local no se enciende para no crear
   * destinatarios reales en cada prueba). Si esta encendida y falla, propaga el
   * error y aborta el registro.
   */
  async registerWithProvider(input: {
    name: string;
    idNumber: string;
    email: string;
  }): Promise<HelgaRecipient | null> {
    const { email } = input;
    if (!isHelgaEnabled()) {
      // TODO(13): encender HELGA_ENABLED cuando la IP fija del backend este en
      // la whitelist. Mientras, el casillero queda sin enlazar y hara falta un
      // proceso de sincronizacion para los creados en este periodo.
      if (!isProd) console.log(`[auth] Helga deshabilitado: casillero de ${email} sin enlazar.`);
      return null;
    }
    return createHelgaRecipient({
      fullName: input.name,
      idNumber: input.idNumber,
      realEmail: email,
    });
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
