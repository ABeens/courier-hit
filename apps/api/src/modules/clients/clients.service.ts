/**
 * Casilleros: lectura para el panel administrador, edicion comercial por el
 * staff y edicion del propio perfil por el cliente.
 *
 * La direccion se devuelve como CODIGOS territoriales (provincia/canton/distrito),
 * no como etiquetas: el catalogo vive en @courier/shared y es la web quien lo
 * resuelve a nombres.
 *
 * Tres decisiones que viven aqui:
 *
 * 1. EDITAR ES REVISAR. El manual lo dice explicito: al entrar a editar un
 *    cliente el flag "Nuevo" se apaga, "esto garantiza que ya revisaron al
 *    cliente". Por eso `reviewStatus` no viaja en el cuerpo: se deriva del acto.
 * 2. CAMBIAR EL CORREO OBLIGA A VERIFICARLO. El correo es el usuario de login;
 *    aceptarlo sin comprobar que existe dejaria al cliente fuera de su cuenta y a
 *    nosotros escribiendo a una direccion equivocada.
 *
 *    TEMPORAL: por eso mismo el cambio esta BLOQUEADO en `updateProfile`. Hoy no
 *    hay transporte de correo real ni pantalla para verificar una direccion fuera
 *    del registro, asi que aceptarlo dejaria la cuenta sin verificar, sin sesion y
 *    sin ruta de regreso. La logica de reverificacion queda comentada en su sitio
 *    para reactivarla cuando el flujo tenga su paso de verificacion.
 * 3. LA DIRECCION SE MUEVE SOLO CON EL CASILLERO EN CALMA. El cliente la edita
 *    el mismo, pero unicamente si no tiene tramites en curso: el distrito manda
 *    la ruta de reparto y la operacion lee la direccion en vivo. Ver
 *    `updateAddress`.
 */
import { ClientReviewStatus, lockerAddressFor } from '@courier/shared';
import type {
  DeliveryAddressInput,
  Session,
  UpdateClientInput,
  UpdateProfileInput,
} from '@courier/shared';
import { AuthErrors, ClientErrors, ShipmentErrors } from '../../core/errors';
import { authRepo } from '../auth/auth.repo';
// TODO(correo): vuelve al reactivar el cambio de correo (reemite el codigo).
// import { authService } from '../auth/auth.service';
import { shipmentsRepo } from '../shipments/shipments.repo';
import { clientsRepo } from './clients.repo';

/** Casillero tal como lo ve el panel administrador. */
export interface ClientListItem {
  id: string;
  /** Codigo de casillero `HS-1000`. */
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
      lines: lockerAddressFor(row.name, row.code),
    };
  },

  /**
   * Perfil del titular de la sesion, para precargar el formulario de edicion.
   *
   * Trae ademas si la direccion se puede editar AHORA y cuantos tramites la
   * tienen trabada. Va en la misma respuesta a proposito: sin ese dato la web
   * solo podria descubrir el candado al fallar el guardado, y el cliente habria
   * llenado el formulario para nada.
   */
  async profile(session: Session) {
    if (!session.clientId) throw ShipmentErrors.missingClientProfile();
    const row = await clientsRepo.findById(session.clientId);
    if (!row) throw ShipmentErrors.missingClientProfile();

    const activeShipmentCount = await shipmentsRepo.countActiveByClient(session.clientId);

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
      /** Tramites en curso (no entregados) que hoy bloquean el cambio. */
      activeShipmentCount,
      canEditAddress: activeShipmentCount === 0,
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

    // BLOQUEADO (temporal). Ver el bloque comentado abajo y AuthErrors.emailChangeDisabled.
    if (input.email !== undefined && input.email !== current.email) {
      throw AuthErrors.emailChangeDisabled();
    }

    /* TODO(correo): reactivar el cambio de correo cuando el flujo tenga su paso de
       verificacion. Descomentar este bloque, el de mas abajo y el campo en
       ProfileScreen; el resto (reemision del codigo, corte de sesion) ya funciona.

    const emailChanged = input.email !== undefined && input.email !== current.email;
    if (emailChanged) {
      const clash = await authRepo.findUserByEmail(input.email!);
      if (clash) throw AuthErrors.emailInUse();
    }
    */

    if (input.idNumber !== undefined && input.idNumber !== current.idNumber) {
      const clash = await authRepo.findClientByIdNumber(input.idNumber);
      if (clash && clash.id !== session.clientId) throw AuthErrors.idNumberInUse();
      await clientsRepo.update(session.clientId, { idNumber: input.idNumber });
    }

    await authRepo.updateUser(session.userId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      // ...(emailChanged ? { email: input.email, emailVerifiedAt: null } : {}),
    });

    /* TODO(correo): parte 2 del bloqueo de arriba. Va tal cual al reactivarlo.

    if (emailChanged) {
      await authService.issueVerificationCode(session.userId, input.email!);
      // La sesion se corta: la cuenta ya no esta verificada y seguir dentro con
      // ella contradiria la barrera del login.
      await authRepo.deleteSessionsByUser(session.userId);
    }
    */

    // Se mantiene en la respuesta para no cambiar el contrato: hoy siempre false
    // porque el cambio de correo no se acepta.
    return { emailChanged: false };
  },

  /**
   * Cambio de la direccion de entrega por el propio cliente.
   *
   * Va aparte de `updateProfile` porque no es un dato de contacto mas:
   *
   * - Se guarda COMPLETA, nunca por campos sueltos. La terna
   *   provincia/canton/distrito solo tiene sentido junta (`deliveryAddressSchema`
   *   ya la valida contra el catalogo con `isValidLocation`), y aceptar un PATCH
   *   parcial permitiria dejar un canton que no cuelga de la provincia guardada.
   *
   * - Solo se puede mover con el casillero EN CALMA: cero tramites en curso. El
   *   distrito determina la ruta de reparto (`district_routes`) y ni la hoja del
   *   mensajero ni la proforma copian la direccion al tramite: la leen en vivo
   *   del casillero. Con un paquete en camino, cambiarla lo mandaria a otro lado
   *   sin que nadie en la operacion se entere. Cuando todo esta entregado no hay
   *   nada que redirigir y el cambio es inocuo.
   *
   * La comprobacion es del lado del servidor y no solo de la UI: el candado ES la
   * regla, y `canEditAddress` en el perfil solo sirve para explicarla antes de
   * que el cliente escriba.
   *
   * Nada de esto viaja al proveedor: hacia Helga va siempre la direccion fija de
   * consolidacion (docs/13 §3.6), asi que un cambio aqui no obliga a resincronizar.
   */
  async updateAddress(session: Session, input: DeliveryAddressInput) {
    if (!session.clientId) throw ShipmentErrors.missingClientProfile();
    const current = await clientsRepo.findById(session.clientId);
    if (!current) throw ShipmentErrors.missingClientProfile();

    const activeShipmentCount = await shipmentsRepo.countActiveByClient(session.clientId);
    if (activeShipmentCount > 0) {
      throw ClientErrors.addressLockedByActiveShipments(activeShipmentCount);
    }

    await clientsRepo.update(session.clientId, {
      provinceCode: input.provinceCode,
      cantonCode: input.cantonCode,
      districtCode: input.districtCode,
      addressLine: input.addressLine,
    });

    return this.profile(session);
  },
};
