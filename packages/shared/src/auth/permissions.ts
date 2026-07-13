/**
 * RBAC modelado como entidades y relaciones (no strings quemados).
 * Fuente autoritativa: docs/roles.md §2. Los permisos son FIJOS en codigo
 * (docs/roles.md §1.4); lo dinamico es el `Role` de cada usuario (vive en BD).
 *
 * Entidades:  Resource · Action · Scope · Permission
 * Relaciones: PERMISSION_DEFS (Permission -> Resource/Action/Scope)
 *             ROLE_PERMISSIONS (Role -> Permission[])
 *
 * La distincion de la matriz "Consulta" vs "Si/Total" se expresa con Action
 * (Read vs Write/Manage). El acceso a un modulo del menu se deriva del Resource.
 */
import { Role } from './roles';

/** Modulo/recurso del sistema (equivale a una entrada de menu). */
export enum Resource {
  Prealert = 'prealert',
  Package = 'package',
  Dashboard = 'dashboard',
  Costs = 'costs',
  Tramite = 'tramite',
  Payments = 'payments',
  Delivery = 'delivery',
  Reports = 'reports',
  Clients = 'clients',
  Config = 'config',
  Users = 'users',
  Announcements = 'announcements',
}

/** Verbo de la accion sobre el recurso. */
export enum Action {
  Read = 'read',
  Create = 'create',
  Write = 'write',
  Receive = 'receive',
  Reassign = 'reassign',
  Pay = 'pay',
  Manage = 'manage',
  Validate = 'validate',
  Generate = 'generate',
}

/** Alcance: sobre lo propio (cliente) o sobre todo (staff). */
export enum Scope {
  Own = 'own',
  All = 'all',
}

export enum Permission {
  // --- Portal del cliente (customer) ---
  PrealertCreate = 'prealert.create',
  PackageReadOwn = 'package.read.own',
  PackagePay = 'package.pay',

  // --- Panel administrador (staff) ---
  DashboardRead = 'dashboard.read',
  PackageReceive = 'package.receive',
  PackageRead = 'package.read',
  PackageWrite = 'package.write',
  PackageReassign = 'package.reassign',
  TramiteManage = 'tramite.manage',
  CostsManage = 'costs.manage',
  CostsTramiteManage = 'costs.tramite.manage',
  PaymentsValidate = 'payments.validate',
  DeliveryManage = 'delivery.manage',
  ReportsOperationalBasic = 'reports.operational.basic',
  ReportsOperationalFull = 'reports.operational.full',
  ReportsFinancial = 'reports.financial',
  ClientsRead = 'clients.read',
  ClientsWrite = 'clients.write',
  ConfigManage = 'config.manage',
  UsersManage = 'users.manage',
  AnnouncementsManage = 'announcements.manage',
}

export interface PermissionDef {
  resource: Resource;
  action: Action;
  scope: Scope;
}

/** Relacion Permission -> (Resource, Action, Scope). */
export const PERMISSION_DEFS: Record<Permission, PermissionDef> = {
  [Permission.PrealertCreate]: { resource: Resource.Prealert, action: Action.Create, scope: Scope.Own },
  [Permission.PackageReadOwn]: { resource: Resource.Package, action: Action.Read, scope: Scope.Own },
  [Permission.PackagePay]: { resource: Resource.Package, action: Action.Pay, scope: Scope.Own },

  [Permission.DashboardRead]: { resource: Resource.Dashboard, action: Action.Read, scope: Scope.All },
  [Permission.PackageReceive]: { resource: Resource.Package, action: Action.Receive, scope: Scope.All },
  [Permission.PackageRead]: { resource: Resource.Package, action: Action.Read, scope: Scope.All },
  [Permission.PackageWrite]: { resource: Resource.Package, action: Action.Write, scope: Scope.All },
  [Permission.PackageReassign]: { resource: Resource.Package, action: Action.Reassign, scope: Scope.All },
  [Permission.TramiteManage]: { resource: Resource.Tramite, action: Action.Manage, scope: Scope.All },
  [Permission.CostsManage]: { resource: Resource.Costs, action: Action.Manage, scope: Scope.All },
  [Permission.CostsTramiteManage]: { resource: Resource.Costs, action: Action.Manage, scope: Scope.All },
  [Permission.PaymentsValidate]: { resource: Resource.Payments, action: Action.Validate, scope: Scope.All },
  [Permission.DeliveryManage]: { resource: Resource.Delivery, action: Action.Manage, scope: Scope.All },
  [Permission.ReportsOperationalBasic]: { resource: Resource.Reports, action: Action.Generate, scope: Scope.All },
  [Permission.ReportsOperationalFull]: { resource: Resource.Reports, action: Action.Generate, scope: Scope.All },
  [Permission.ReportsFinancial]: { resource: Resource.Reports, action: Action.Generate, scope: Scope.All },
  [Permission.ClientsRead]: { resource: Resource.Clients, action: Action.Read, scope: Scope.All },
  [Permission.ClientsWrite]: { resource: Resource.Clients, action: Action.Write, scope: Scope.All },
  [Permission.ConfigManage]: { resource: Resource.Config, action: Action.Manage, scope: Scope.All },
  [Permission.UsersManage]: { resource: Resource.Users, action: Action.Manage, scope: Scope.All },
  [Permission.AnnouncementsManage]: { resource: Resource.Announcements, action: Action.Manage, scope: Scope.All },
};

/** Permisos de staff que hereda `admin` (acceso total). */
const ADMIN_PERMISSIONS: readonly Permission[] = [
  Permission.DashboardRead,
  Permission.PackageReceive,
  Permission.PackageRead,
  Permission.PackageWrite,
  Permission.PackageReassign,
  Permission.TramiteManage,
  Permission.CostsManage,
  Permission.CostsTramiteManage,
  Permission.PaymentsValidate,
  Permission.DeliveryManage,
  Permission.ReportsOperationalBasic,
  Permission.ReportsOperationalFull,
  Permission.ReportsFinancial,
  Permission.ClientsRead,
  Permission.ClientsWrite,
  Permission.ConfigManage,
  Permission.UsersManage,
  Permission.AnnouncementsManage,
];

/** Relacion Role -> Permission[]. Matriz literal de docs/roles.md §2. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  [Role.Client]: [Permission.PrealertCreate, Permission.PackageReadOwn, Permission.PackagePay],

  [Role.Admin]: ADMIN_PERMISSIONS,

  [Role.ServicioCliente]: [
    Permission.DashboardRead,
    Permission.PackageRead,
    Permission.ReportsOperationalBasic,
    Permission.ClientsRead,
  ],

  [Role.Operativo]: [
    Permission.DashboardRead,
    Permission.PackageReceive,
    Permission.PackageRead,
    Permission.PackageWrite,
    Permission.PackageReassign,
    Permission.CostsManage,
    Permission.ReportsOperationalBasic,
    Permission.ClientsRead,
  ],

  [Role.Financiero]: [Permission.PackageRead, Permission.ReportsFinancial],

  [Role.Mensajeria]: [Permission.DeliveryManage],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/** Modulos visibles en el menu de un rol (Resource derivado de sus permisos). */
export function resourcesFor(role: Role): ReadonlySet<Resource> {
  return new Set(permissionsFor(role).map((p) => PERMISSION_DEFS[p].resource));
}

/** True si el permiso exige filtrar por dueño (scopeToOwner en la API). */
export function requiresOwnership(permission: Permission): boolean {
  return PERMISSION_DEFS[permission].scope === Scope.Own;
}

export const PERMISSION_VALUES = Object.values(Permission) as [Permission, ...Permission[]];
