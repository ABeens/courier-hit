/**
 * Forma de la sesion que la API resuelve en cada request desde la cookie
 * httpOnly. El cliente NUNCA envia `role` ni `clientCode`; salen del servidor.
 * Fuente: docs/04-seguridad.md §5.
 */
import type { Principal, Role } from './roles';

export interface Session {
  sessionId: string;
  userId: string;
  principal: Principal;
  role: Role;
  /**
   * Id del perfil de casillero; presente solo si principal === Client. Es la
   * clave con la que la API acota "lo propio" (permisos de scope Own): el
   * cliente nunca la envia, se resuelve desde la cookie.
   */
  clientId?: string;
  /** Codigo de casillero `HS-####`; presente solo si principal === Client. */
  clientCode?: string;
}
