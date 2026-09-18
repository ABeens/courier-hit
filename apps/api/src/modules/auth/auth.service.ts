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
  ProviderLinkSource,
  Role,
  UserStatus,
  principalForRole,
} from '@courier/shared';
import type {
  AcceptInviteInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  Session,
  VerifyInput,
} from '@courier/shared';
import { config, isProd } from '../../core/config';
import { AuthErrors } from '../../core/errors';
import { mailer } from '../../core/mailer';
import type { HelgaRecipient } from '../../integrations/helga/helga.client';
import { createHelgaRecipient, isHelgaEnabled } from '../../integrations/helga/helga.client';
// La bitacora del enlace la declara el modulo de casilleros (es donde vive el
// panel que la consulta); aqui solo se ESCRIBE desde los caminos automaticos.
import { providerLinkRepo } from '../clients/provider-link.repo';
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
  async register(
    input: RegisterInput,
  ): Promise<{ userId: string; code: string; verificationCode?: string }> {
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
    const clientRow = await authRepo.insertClient({
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

    // Primer evento de la bitacora del enlace. Sin el, un casillero que nace
    // 'failed' no tendria rastro del motivo original: solo del ultimo reintento.
    await providerLinkRepo.addEvent({
      clientId: clientRow.id,
      source: ProviderLinkSource.Registro,
      status: link.status,
      detail: link.error ?? (link.recipient ? `Destinatario ${link.recipient.id}.` : 'Integración apagada.'),
    });

    // En dev se devuelve el codigo para mostrarlo en la UI (sin SMTP). En prod
    // issueVerificationCode devuelve null: el codigo solo viaja por correo.
    const verificationCode = await this.issueVerificationCode(user.id, user.email);
    return { userId: user.id, code, verificationCode: verificationCode ?? undefined };
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
      // TODO(13): poner HELGA_MODE=on cuando la IP fija del backend este en
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

      // Bitacora del intento. Es lo que permite distinguir "falló una vez" de
      // "lleva 40 intentos con el mismo error", que es la diferencia entre esperar
      // al robot y corregirlo a mano.
      await providerLinkRepo.addEvent({
        clientId: client.id,
        source: ProviderLinkSource.Reconciliacion,
        status: link.status,
        detail: link.error ?? (link.recipient ? `Destinatario ${link.recipient.id}.` : null),
        changes: link.recipient
          ? { helgaClientId: { from: null, to: link.recipient.id } }
          : null,
      });

      if (link.status === HelgaSyncStatus.Synced) report.synced += 1;
      else report.failed += 1;
    }
    return report;
  },

  /**
   * Genera y guarda (hasheado) un codigo de 6 digitos; "envia" por email.
   *
   * Devuelve el codigo en desarrollo y null en produccion, igual que
   * `issueInvitation` con el enlace de staff: mientras no hay SMTP, el llamador
   * puede mostrarlo en la UI en vez de obligar a leer el log.
   */
  async issueVerificationCode(userId: string, email: string): Promise<string | null> {
    const code = newVerificationCode();
    const expiresAt = new Date(Date.now() + config.EMAIL_CODE_TTL_MINUTES * 60_000);
    await authRepo.deleteVerifications(userId); // invalida codigos anteriores
    await authRepo.insertVerification({ userId, codeHash: sha256(code), expiresAt });

    await mailer.send({
      to: email,
      subject: 'Verifica tu correo — HS Global Services',
      body: [
        'Bienvenido(a) a HS Global Services.',
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

    // En produccion NUNCA sale del servidor: el codigo viaja solo por correo.
    return isProd ? null : code;
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
      subject: 'Tu acceso al panel de HS Global Services',
      body: [
        'Se creó una cuenta para ti en el panel de HS Global Services.',
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

  /**
   * Emite un token de restablecimiento para el flujo "olvide mi contrasena".
   *
   * No devuelve NADA que distinga un correo registrado de uno que no lo esta, y
   * tampoco lanza: quien pregunta no esta autenticado, y responder distinto
   * convertiria este endpoint en un detector de clientes de la casa. Por lo
   * mismo callan los dos casos en los que no se manda correo: cuenta inexistente
   * y cuenta deshabilitada.
   *
   * Un usuario deshabilitado no recibe enlace a proposito: `login` lo rechaza de
   * todas formas (`userInactive`), asi que darselo solo serviria para que fije
   * una contrasena con la que sigue sin poder entrar.
   */
  async requestPasswordReset(input: ForgotPasswordInput): Promise<{ ok: true }> {
    const user = await authRepo.findUserByEmail(input.email);
    if (!user || user.status !== UserStatus.Activo) return { ok: true };

    const token = newToken();
    const expiresAt = new Date(Date.now() + config.RESET_TTL_MINUTES * 60_000);
    // Solo el ultimo enlace enviado sirve: pedirlo de nuevo anula el anterior.
    await authRepo.invalidatePasswordResets(user.id, 'reset');
    await authRepo.insertPasswordReset({ userId: user.id, tokenHash: sha256(token), purpose: 'reset', expiresAt });

    const link = `${config.WEB_ORIGIN}/restablecer?token=${token}`;
    await mailer.send({
      to: user.email,
      subject: 'Restablece tu contraseña — HS Global Services',
      body: [
        `Hola ${user.name},`,
        '',
        'Recibimos una solicitud para restablecer la contraseña de tu cuenta.',
        'Define una nueva en el siguiente enlace:',
        link,
        '',
        `El enlace vence en ${config.RESET_TTL_MINUTES} minutos y solo se puede usar una vez.`,
        'Si no fuiste tú, ignora este mensaje: tu contraseña actual sigue funcionando.',
        '',
        'Saludos cordiales,',
        'Equipo HS Global',
      ].join('\n'),
    });

    // El enlace NO se devuelve ni en desarrollo, a diferencia del codigo de
    // registro o de la invitacion de staff: aquellos llegan a quien ya es dueño
    // del flujo (se acaba de registrar, o es el admin que creo la cuenta), y
    // este lo puede pedir cualquiera para el correo de cualquiera. En desarrollo
    // el enlace sale por el log del mailer (transporte de consola).
    return { ok: true };
  },

  /**
   * Fija la contrasena a partir de un token de `password_resets` y deja la
   * cuenta lista para entrar. Lo comparten la invitacion de staff y el olvido de
   * contrasena: los dos llegan con un token del correo y terminan igual. El
   * `purpose` de la fila queda como rastro de por que se emitio, no como una
   * bifurcacion de comportamiento.
   */
  async setPasswordFromToken(input: AcceptInviteInput | ResetPasswordInput): Promise<{ ok: true }> {
    const reset = await authRepo.findValidPasswordReset(sha256(input.token));
    if (!reset) throw AuthErrors.invalidToken();

    const passwordHash = await hash(input.password);
    await authRepo.setPassword(reset.userId, passwordHash);
    await authRepo.markPasswordResetUsed(reset.id);
    // Llegar hasta aqui con el token del correo prueba la titularidad del email.
    await authRepo.markEmailVerified(reset.userId);
    /**
     * Cambiar la contrasena echa a TODAS las sesiones abiertas de esa cuenta.
     * Es la mitad util del flujo cuando el motivo del reset es que alguien mas
     * entro: sin esto, el atacante conserva su cookie (7 dias de TTL) y cambiar
     * la clave no lo saca. Aplica igual a la invitacion de staff, donde no hay
     * sesiones que perder porque la cuenta es nueva.
     */
    await authRepo.deleteSessionsByUser(reset.userId);
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

  /**
   * Arma el objeto Session del dominio; agrega clientCode si es customer.
   *
   * Tambien trae la bandera de acceso a la API del casillero. Se lee AQUI, en
   * cada resolucion de sesion, y no se guarda en la fila de `sessions`: asi
   * apagarla surte efecto en la siguiente peticion del cliente, igual que el
   * bloqueo de la cuenta, en vez de esperar a que caduque la cookie.
   */
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
        session.apiAccess = client.apiAccessEnabled;
      }
    }
    // Consistencia defensiva: el principal siempre concuerda con el rol.
    session.principal = principalForRole(user.role);
    return session;
  },
};
