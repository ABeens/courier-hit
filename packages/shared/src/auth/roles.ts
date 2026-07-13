/**
 * Entidades de identidad: poblacion (principal) y rol.
 * Fuente autoritativa: docs/roles.md §1.2. Refina docs/04 §3 y docs/02b §5.
 *
 * `Principal` separa las dos poblaciones que conviven en la tabla `users`:
 *   - Client (customer): cliente final con casillero, se autoregistra.
 *   - Staff: personal interno; lo crea un admin, su acceso depende del `Role`.
 *
 * Las claves (valor del enum) son estables: alimentan el enum de Postgres.
 */

export enum Principal {
  Client = 'client',
  Staff = 'staff',
}

export enum Role {
  Client = 'client',
  Admin = 'admin',
  ServicioCliente = 'servicio_cliente',
  Operativo = 'operativo',
  Financiero = 'financiero',
  Mensajeria = 'mensajeria',
}

/** Etiqueta de presentacion (docs/roles.md §1.2). Clave canonica = valor enum. */
export const ROLE_LABELS: Record<Role, string> = {
  [Role.Client]: 'Cliente',
  [Role.Admin]: 'Administrador',
  [Role.ServicioCliente]: 'Servicio al Cliente',
  [Role.Operativo]: 'Operativo',
  [Role.Financiero]: 'Financiero',
  [Role.Mensajeria]: 'Mensajería',
};

/** Roles de la poblacion Staff (todos menos Client). */
export const STAFF_ROLES: readonly Role[] = [
  Role.Admin,
  Role.ServicioCliente,
  Role.Operativo,
  Role.Financiero,
  Role.Mensajeria,
];

export function isStaffRole(role: Role): boolean {
  return role !== Role.Client;
}

/** El principal se deriva del rol; nunca lo manda el cliente. */
export function principalForRole(role: Role): Principal {
  return role === Role.Client ? Principal.Client : Principal.Staff;
}

/** Valores para construir los enums de la BD (Drizzle pgEnum), sin repetirlos. */
export const PRINCIPAL_VALUES = Object.values(Principal) as [Principal, ...Principal[]];
export const ROLE_VALUES = Object.values(Role) as [Role, ...Role[]];
