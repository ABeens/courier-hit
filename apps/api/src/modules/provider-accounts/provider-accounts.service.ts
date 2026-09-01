/**
 * Mantenimiento de las cuentas EXCLUSIVAS del proveedor y alta de su cliente
 * consolidado (docs/13 §6).
 *
 * DOS COSAS EN UN SOLO SITIO, y no por comodidad: una cuenta exclusiva sin
 * cliente no importa nada, y un cliente consolidado sin cuenta no existe como
 * tal. Son las dos mitades del mismo acto administrativo, asi que el alta del
 * cliente cuelga de la cuenta (`POST /provider-accounts/:id/client`) y no del
 * modulo de clientes.
 *
 * TRES REGLAS DE NEGOCIO QUE SE APLICAN AQUI:
 *
 * 1. Nadie elige su cuenta. Quien se registra por el landing queda SIEMPRE en la
 *    principal; no hay ningun camino publico que llegue a este archivo.
 * 2. Solo un administrador crea un cliente consolidado, y solo desde aqui.
 * 3. Un cliente que ya existe NO se convierte. El alta crea usuario y casillero
 *    nuevos; no hay endpoint para enganchar a uno existente, y no es un olvido:
 *    su paqueteria historica cuelga de sub-casilleros de la principal y no se
 *    puede reatribuir a otra cuenta sin mentir sobre de donde vino cada paquete.
 */
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import {
  ClientReviewStatus,
  HelgaSyncStatus,
  Principal,
  ProviderAccountKind,
  ProviderLinkSource,
  Role,
  UserStatus,
} from '@courier/shared';
import type {
  CreateConsolidatedClientInput,
  CreateProviderAccountInput,
  ProviderAccountDto,
  ProviderAccountListDto,
  Session,
  UpdateProviderAccountInput,
} from '@courier/shared';
import type { HelgaAccount } from '../../core/config';
import { helgaPrincipalAccount } from '../../core/config';
import { AuthErrors, ProviderAccountErrors } from '../../core/errors';
import { decryptSecret, encryptSecret, secretsKeyConfigured } from '../../core/secrets';
import { authRepo } from '../auth/auth.repo';
import { authService } from '../auth/auth.service';
import { providerLinkRepo } from '../clients/provider-link.repo';
import { tariffsRepo } from '../tariffs/tariffs.repo';
import type { ProviderAccountWithClient } from './provider-accounts.repo';
import { providerAccountsRepo } from './provider-accounts.repo';
import type { ProviderAccountRow } from './provider-accounts.schema';

/**
 * Una cuenta lista para que la recorra la importacion: las credenciales ya
 * descifradas y, si es exclusiva, el cliente al que hay que atribuirle todo.
 */
export interface ImportableAccount {
  /** `null` en la principal: no es una fila de la base, viene del entorno. */
  id: string | null;
  kind: ProviderAccountKind;
  account: HelgaAccount;
  /**
   * Dueno de TODO lo que traiga la cuenta. `null` en la principal, donde el dueno
   * se resuelve paquete a paquete por su `destinatario_id`.
   */
  consolidatedClientId: string | null;
}

function toDto(row: ProviderAccountWithClient): ProviderAccountDto {
  const { account, client } = row;
  return {
    id: account.id,
    kind: ProviderAccountKind.Exclusiva,
    code: account.code,
    name: account.name,
    username: account.username,
    providerCustomerId: account.providerCustomerId,
    hasOwnAppCredentials: Boolean(account.oauthClientId && account.oauthClientSecretEncrypted),
    active: account.active,
    client,
    lastImportAt: account.lastImportAt?.toISOString() ?? null,
    lastImportError: account.lastImportError,
    createdAt: account.createdAt.toISOString(),
  };
}

/**
 * La cuenta principal como fila del panel: solo lectura y sin id.
 *
 * Se lista aunque no se administre desde aqui porque la pregunta que hace un
 * administrador al abrir esta pantalla es "¿contra que cuentas trabaja el
 * sistema?", y una lista que empieza en la segunda no la responde.
 */
function principalDto(): ProviderAccountDto | null {
  if (!helgaPrincipalAccount) return null;
  return {
    id: null,
    kind: ProviderAccountKind.Principal,
    code: helgaPrincipalAccount.code,
    name: helgaPrincipalAccount.name,
    username: helgaPrincipalAccount.username,
    providerCustomerId: helgaPrincipalAccount.clientId,
    hasOwnAppCredentials: false,
    active: true,
    client: null,
    lastImportAt: null,
    lastImportError: null,
    createdAt: null,
  };
}

/** Credenciales de la fila, descifradas, en la forma que espera el cliente HTTP. */
function toHelgaAccount(row: ProviderAccountRow): HelgaAccount {
  return {
    code: row.code,
    name: row.name,
    username: row.username,
    password: decryptSecret(row.passwordEncrypted),
    clientId: row.providerCustomerId,
    oauthClientId: row.oauthClientId,
    oauthClientSecret: row.oauthClientSecretEncrypted
      ? decryptSecret(row.oauthClientSecretEncrypted)
      : null,
    appId: row.appId,
  };
}

/** Falla claro ANTES de escribir si el despliegue no puede cifrar. */
function requireSecrets(): void {
  if (!secretsKeyConfigured()) throw ProviderAccountErrors.secretsUnavailable();
}

export const providerAccountsService = {
  /** La principal (de la configuracion) primero, y despues las exclusivas. */
  async list(): Promise<ProviderAccountListDto> {
    const rows = await providerAccountsRepo.list();
    const principal = principalDto();
    return { items: [...(principal ? [principal] : []), ...rows.map(toDto)] };
  },

  async create(session: Session, input: CreateProviderAccountInput): Promise<ProviderAccountDto> {
    requireSecrets();

    // El codigo es la llave natural: el indice unico ya lo impide, pero un 409 con
    // el codigo dentro se lee mucho mejor que un error de restriccion.
    const clash = await providerAccountsRepo.findByCode(input.code);
    if (clash) throw ProviderAccountErrors.codeInUse(input.code);

    const created = await providerAccountsRepo.insert({
      code: input.code,
      name: input.name,
      username: input.username,
      passwordEncrypted: encryptSecret(input.password),
      oauthClientId: input.oauthClientId ?? null,
      oauthClientSecretEncrypted: input.oauthClientSecret
        ? encryptSecret(input.oauthClientSecret)
        : null,
      appId: input.appId ?? null,
      providerCustomerId: input.providerCustomerId ?? null,
      createdBy: session.userId,
    });

    return toDto({ account: created, client: null });
  },

  /**
   * Edicion de la cuenta. Un secreto que no viene NO se toca: el panel nunca los
   * recibe, asi que no puede reenviarlos, y tratarlos como "vaciar" dejaria la
   * cuenta sin poder autenticarse en la siguiente corrida.
   */
  async update(
    id: string,
    input: UpdateProviderAccountInput,
  ): Promise<ProviderAccountDto> {
    const current = await providerAccountsRepo.findById(id);
    if (!current) throw ProviderAccountErrors.notFound();
    if (input.password !== undefined || input.oauthClientSecret !== undefined) requireSecrets();

    await providerAccountsRepo.update(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.password !== undefined ? { passwordEncrypted: encryptSecret(input.password) } : {}),
      ...(input.oauthClientId !== undefined ? { oauthClientId: input.oauthClientId || null } : {}),
      ...(input.oauthClientSecret !== undefined
        ? {
            oauthClientSecretEncrypted: input.oauthClientSecret
              ? encryptSecret(input.oauthClientSecret)
              : null,
          }
        : {}),
      ...(input.appId !== undefined ? { appId: input.appId || null } : {}),
      ...(input.providerCustomerId !== undefined
        ? { providerCustomerId: input.providerCustomerId ?? null }
        : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    });

    const updated = await providerAccountsRepo.findById(id);
    if (!updated) throw ProviderAccountErrors.notFound();
    return toDto(updated);
  },

  /**
   * Alta del cliente consolidado de una cuenta: crea el usuario y su casillero, y
   * los ata a la cuenta.
   *
   * TRES DIFERENCIAS CON EL AUTOREGISTRO, y las tres tienen el mismo motivo (este
   * cliente NO cuelga de la cuenta principal):
   *
   * 1. NO SE LLAMA A HELGA. El autoregistro crea un destinatario bajo la cuenta
   *    principal (op. D) para que los paquetes del cliente tengan a quien
   *    atribuirse. Aqui eso sobra y ademas seria un error: el cliente ya tiene su
   *    propia cuenta, con sus propios sub-casilleros creados por el administrador
   *    del proveedor. Su enlace ES la cuenta.
   * 2. NACE `synced`, con `helgaClientId` en `null`. Con la integracion encendida
   *    el login exige `synced` (`auth.service.login`), y este cliente no tiene ni
   *    va a tener un `destinatario_id` que exhibir. Dejarlo `pending` lo dejaria
   *    fuera del portal para siempre y ademas lo metaria en la cola del robot,
   *    que intentaria darlo de alta en la cuenta equivocada.
   * 3. NO SE FIJA CONTRASENA. El administrador nunca la conoce: se manda una
   *    invitacion para que el titular la defina, igual que con el staff
   *    (docs/roles.md §1.3.4).
   */
  async createConsolidatedClient(
    session: Session,
    accountId: string,
    input: CreateConsolidatedClientInput,
  ): Promise<{ account: ProviderAccountDto; inviteLink?: string }> {
    const current = await providerAccountsRepo.findById(accountId);
    if (!current) throw ProviderAccountErrors.notFound();
    if (current.account.consolidatedClientId) throw ProviderAccountErrors.clientAlreadySet();

    // Las mismas precondiciones del autoregistro, y por el mismo motivo: email y
    // cedula son unicos en TODA la poblacion, y un casillero sin tarifa no se
    // puede cotizar.
    const existing = await authRepo.findUserByEmail(input.email);
    if (existing) throw AuthErrors.emailInUse();
    const sameIdNumber = await authRepo.findClientByIdNumber(input.idNumber);
    if (sameIdNumber) throw AuthErrors.idNumberInUse();
    const defaultRate = await tariffsRepo.findDefault();
    if (!defaultRate) throw AuthErrors.defaultRateMissing();

    // Hash inutilizable: bloquea el login hasta que se acepte la invitacion.
    const placeholderHash = await hash(randomBytes(32).toString('hex'));
    const user = await authRepo.insertUser({
      email: input.email,
      passwordHash: placeholderHash,
      principal: Principal.Client,
      role: Role.Client,
      name: input.name,
      phone: input.phone,
      status: UserStatus.Activo,
    });

    const code = await authRepo.nextClientCode();
    const client = await authRepo.insertClient({
      userId: user.id,
      code,
      idNumber: input.idNumber,
      provinceCode: input.provinceCode,
      cantonCode: input.cantonCode,
      districtCode: input.districtCode,
      addressLine: input.addressLine,
      reviewStatus: ClientReviewStatus.Nuevo,
      clientRateId: defaultRate.id,
      // Sin destinatario nuestro en Helga: ver la decision 1 de arriba.
      helgaClientId: null,
      /**
       * El "sub-casillero" que ve este cliente en el portal es el CODIGO DE SU
       * CUENTA: en Miami recibe bajo su propia cuenta, no bajo un sub-casillero
       * de la de HS Global. Es lo unico que puede poner en sus compras.
       */
      helgaSubLocker: current.account.code,
      helgaSyncedAt: new Date(),
      helgaSyncStatus: HelgaSyncStatus.Synced,
      helgaSyncAttempts: 0,
      helgaLastError: null,
    });

    await providerAccountsRepo.update(accountId, { consolidatedClientId: client.id });

    // Bitacora del enlace, igual que en el autoregistro: sin ella este casillero
    // seria el unico `synced` del sistema sin ningun rastro de por que lo esta.
    await providerLinkRepo.addEvent({
      clientId: client.id,
      source: ProviderLinkSource.Manual,
      status: HelgaSyncStatus.Synced,
      detail: `Cliente consolidado de la cuenta ${current.account.code} (${current.account.name}).`,
      createdBy: session.userId,
    });

    const inviteLink = await authService.issueInvitation(user.id, user.email);

    const refreshed = await providerAccountsRepo.findById(accountId);
    return {
      account: toDto(refreshed ?? current),
      ...(inviteLink ? { inviteLink } : {}),
    };
  },

  /**
   * Las cuentas que recorre la importacion, EN ORDEN: la principal primero y
   * despues las exclusivas.
   *
   * El orden importa poco para el resultado y mucho para el diagnostico: la
   * principal es la que atiende a todo el mundo, y verla siempre en la primera
   * linea del log de cada corrida hace evidente si corrio o no.
   *
   * Una cuenta cuyas credenciales no se pueden descifrar se OMITE con un aviso en
   * vez de tumbar la corrida: el resto de cuentas tiene paquetes esperando y la
   * ventana de captura de la op. E no se repite (ver `provider-discovery`).
   */
  async accountsForImport(): Promise<ImportableAccount[]> {
    const out: ImportableAccount[] = [];

    if (helgaPrincipalAccount) {
      out.push({
        id: null,
        kind: ProviderAccountKind.Principal,
        account: helgaPrincipalAccount,
        consolidatedClientId: null,
      });
    }

    for (const row of await providerAccountsRepo.listImportable()) {
      try {
        out.push({
          id: row.id,
          kind: ProviderAccountKind.Exclusiva,
          account: toHelgaAccount(row),
          consolidatedClientId: row.consolidatedClientId,
        });
      } catch (err) {
        console.error(`[helga] no se pudieron leer las credenciales de ${row.code}:`, err);
        await providerAccountsRepo.markImport(
          row.id,
          'No se pudieron descifrar las credenciales guardadas.',
        );
      }
    }

    return out;
  },
};
