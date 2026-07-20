/**
 * Entidad Usuario (identidad) y perfil de cliente.
 * Fuente: docs/05-modulo-usuarios.md, docs/02b §4.1-4.2, docs/roles.md §1.
 *
 * Una sola tabla de identidad (`users`) para ambas poblaciones; el perfil de
 * casillero (`ClientProfile`) es 1:1 y solo existe para principal = Client.
 * El hash de contraseña NO forma parte del dominio: nunca sale del servidor.
 */
import type { Principal, Role } from './roles';

export enum UserStatus {
  Activo = 'activo',
  Inactivo = 'inactivo',
}

export const USER_STATUS_VALUES = Object.values(UserStatus) as [UserStatus, ...UserStatus[]];

/** Identidad de un usuario (customer o staff). Vista publica, sin credenciales. */
export interface User {
  id: string;
  email: string;
  name: string;
  phone: string | null; // opcional; lo tienen ambas poblaciones (docs/roles.md §1.3.3)
  principal: Principal;
  role: Role;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Estado de revision del casillero. Todo casillero nace `nuevo` para que un
 * administrador valide despues sus datos (cedula, direccion); revisarlo es un
 * acto manual del staff, no algo que el cliente pueda cambiar.
 */
export enum ClientReviewStatus {
  Nuevo = 'nuevo',
  Revisado = 'revisado',
}

export const CLIENT_REVIEW_STATUS_VALUES = Object.values(ClientReviewStatus) as [
  ClientReviewStatus,
  ...ClientReviewStatus[],
];

/** Perfil de casillero: extension 1:1 de User cuando principal = Client. */
export interface ClientProfile {
  userId: string;
  code: string; // 'HS-1042' — clave de negocio, visible al cliente
  idNumber: string; // cedula normalizada a solo digitos; unica en el sistema
  /** Direccion de entrega en Costa Rica (codigos del catalogo `geo`). */
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string; // "otras senas"
  reviewStatus: ClientReviewStatus;
  /** Tarifa asignada; al registrarse es la tarifa por defecto del sistema. */
  clientRateId: string | null;
  /**
   * Id del cliente/destinatario en Helga (docs/13). Es el enlace con el
   * proveedor: nuestro `userId` de un lado, su id del otro.
   */
  helgaClientId: string | null;
  helgaSyncedAt: Date | null;
  memberSince: Date | null;
}
