/**
 * Casilleros: lectura para el panel administrador, edicion comercial por el
 * staff y edicion del propio perfil por el cliente.
 *
 * La direccion se devuelve como CODIGOS territoriales (provincia/canton/distrito),
 * no como etiquetas: el catalogo vive en @courier/shared y es la web quien lo
 * resuelve a nombres.
 *
 * Dos decisiones que viven aqui:
 *
 * 1. EDITAR ES REVISAR. El manual lo dice explicito: al entrar a editar un
 *    cliente el flag "Nuevo" se apaga, "esto garantiza que ya revisaron al
 *    cliente". Por eso `reviewStatus` no viaja en el cuerpo: se deriva del acto.
 * 2. CAMBIAR EL CORREO OBLIGA A VERIFICARLO. El correo es el usuario de login;
 *    aceptarlo sin comprobar que existe dejaria al cliente fuera de su cuenta y a
 *    nosotros escribiendo a una direccion equivocada.
 */
import { ClientReviewStatus, lockerAddressFor } from '@courier/shared';
import type { Session, UpdateClientInput, UpdateProfileInput } from '@courier/shared';
import { AuthErrors, ShipmentErrors } from '../../core/errors';
import { authRepo } from '../auth/auth.repo';
import { authService } from '../auth/auth.service';
import { clientsRepo } from './clients.repo';

/** Casillero tal como lo ve el panel administrador. */
export interface ClientListItem {
  id: string;
  /** Codigo de casillero `HS-1042`. */
  code: string;
  name: string;
  email: string;
  phone: string | null;
  idNumber: string;
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
  reviewStatus: ClientReviewStatus;
  /** Nombre de la tarifa asignada; null si quedo sin tarifa. */
  clientRateName: string | null;
  clientRateId: string | null;
  /** Techo de credito y su moneda (regla M2: nunca una cifra sin moneda). */
  creditLimit: number | null;
  creditLimitCurrency: string | null;
  shipmentCount: number;
}

export const clientsService = {
  async list(q?: string): Promise<{ items: ClientListItem[] }> {
    const rows = await clientsRepo.list(q);
    return { items: rows.map(({ createdAt: _createdAt, ...item }) => item) };
  },

  async get(id: string): Promise<ClientListItem> {
    const row = await clientsRepo.findById(id);
    if (!row) throw ShipmentErrors.clientNotFound();
    const { createdAt: _createdAt, ...item } = row;
    return item;
  },

  /**
   * Edicion comercial por el staff (tarifa y limite de credito). Apaga el flag
   * "Nuevo" en la misma operacion: haber entrado a editar ES la revision.
   */
  async update(id: string, input: UpdateClientInput): Promise<ClientListItem> {
    const current = await clientsRepo.findById(id);
    if (!current) throw ShipmentErrors.clientNotFound();

    await clientsRepo.update(id, {
      ...(input.clientRateId !== undefined ? { clientRateId: input.clientRateId } : {}),
      ...(input.creditLimit !== undefined ? { creditLimit: input.creditLimit } : {}),
      ...(input.creditLimitCurrency !== undefined
        ? { creditLimitCurrency: input.creditLimitCurrency }
        : {}),
      reviewStatus: ClientReviewStatus.Revisado,
    });

    return this.get(id);
  },

  /** Casillero en Miami del titular de la sesion (Parte 2, "Casillero"). */
  async locker(session: Session) {
    if (!session.clientId) throw ShipmentErrors.missingClientProfile();
    const row = await clientsRepo.findById(session.clientId);
    if (!row) throw ShipmentErrors.missingClientProfile();

    return {
      clientCode: row.code,
      /** Sub-casillero del proveedor; `null` si el casillero aun no se sincronizo. */
      subLocker: row.helgaSubLocker,
      lines: lockerAddressFor(row.name, row.code, row.helgaSubLocker),
    };
  },

  /** Perfil del titular de la sesion, para precargar el formulario de edicion. */
  async profile(session: Session) {
    if (!session.clientId) throw ShipmentErrors.missingClientProfile();
    const row = await clientsRepo.findById(session.clientId);
    if (!row) throw ShipmentErrors.missingClientProfile();

    return {
      code: row.code,
      name: row.name,
      email: row.email,
      phone: row.phone,
      idNumber: row.idNumber,
      provinceCode: row.provinceCode,
      cantonCode: row.cantonCode,
      districtCode: row.districtCode,
      addressLine: row.addressLine,
    };
  },

  /**
   * Edicion del propio perfil (Parte 2, "Editar Perfil").
   *
   * El correo se trata aparte del resto: cambiarlo cambia el usuario de login, asi
   * que la cuenta vuelve a quedar SIN VERIFICAR y sale un codigo nuevo a la
   * direccion nueva. Es deliberadamente incomodo —el cliente tiene que verificar
   * otra vez para entrar— porque la alternativa es peor: un tecleo mal dado en el
   * correo lo dejaria sin cuenta y sin forma de recuperarla.
   */
  async updateProfile(session: Session, input: UpdateProfileInput) {
    if (!session.clientId) throw ShipmentErrors.missingClientProfile();
    const current = await clientsRepo.findById(session.clientId);
    if (!current) throw ShipmentErrors.missingClientProfile();

    const emailChanged = input.email !== undefined && input.email !== current.email;
    if (emailChanged) {
      const clash = await authRepo.findUserByEmail(input.email!);
      if (clash) throw AuthErrors.emailInUse();
    }

    if (input.idNumber !== undefined && input.idNumber !== current.idNumber) {
      const clash = await authRepo.findClientByIdNumber(input.idNumber);
      if (clash && clash.id !== session.clientId) throw AuthErrors.idNumberInUse();
      await clientsRepo.update(session.clientId, { idNumber: input.idNumber });
    }

    await authRepo.updateUser(session.userId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(emailChanged ? { email: input.email, emailVerifiedAt: null } : {}),
    });

    if (emailChanged) {
      await authService.issueVerificationCode(session.userId, input.email!);
      // La sesion se corta: la cuenta ya no esta verificada y seguir dentro con
      // ella contradiria la barrera del login.
      await authRepo.deleteSessionsByUser(session.userId);
    }

    return { emailChanged };
  },
};
