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
  /**
   * Si este casillero tiene HABILITADO el acceso a la API (`clients.api_access`).
   * Presente solo si principal === Client, y `false` mientras un administrador no
   * lo encienda: la integracion por llaves no viene con la cuenta, se contrata.
   *
   * Viaja en la sesion porque la decide el dueño del casillero, no el rol: dos
   * clientes con el mismo rol pueden tenerla distinta, asi que el RBAC no puede
   * responder por ella. Es lo que gobierna la pantalla "API" del portal y los
   * endpoints de autogestion de llaves; la API publica no la lee de aqui (no hay
   * sesion ahi), la consulta en vivo con la llave.
   */
  apiAccess?: boolean;
}
