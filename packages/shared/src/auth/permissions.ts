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
  /** Casillero en Miami del titular (Parte 2, "Casillero"). */
  Locker = 'locker',
  /** Datos de contacto del propio titular (Parte 2, "Editar Perfil"). */
  Profile = 'profile',
  /**
   * Recepcion en bodega. Es un modulo propio y no una accion sobre Package
   * porque la matriz de roles lo lista como fila aparte ("Recepción (escaneo/
   * registro de paquetes)"): tiene su propia pantalla y su propia poblacion.
   */
  Reception = 'reception',
  Dashboard = 'dashboard',
  Costs = 'costs',
  CostServices = 'cost_services',
  Tramite = 'tramite',
  Payments = 'payments',
  Delivery = 'delivery',
  Reports = 'reports',
  Clients = 'clients',
  Config = 'config',
  /**
   * Ajustes generales del sistema (pantalla "Configuración"). Son los valores
   * que el sistema aplica IGUAL a todos los tramites, no datos de uno: hoy solo
   * la tasa de cambio, y es el cajon donde entraran los que vengan.
   */
  Settings = 'settings',
  Tariffs = 'tariffs',
  Routes = 'routes',
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
  /**
   * Enmendar un dato ya asentado, fuera del flujo normal. Se distingue de Write
   * y Manage porque no es operar el proceso sino arreglar el resultado de haberlo
   * operado mal: no la tiene quien ejecuta, solo quien responde por el sistema.
   */
  Correct = 'correct',
}

/** Alcance: sobre lo propio (cliente) o sobre todo (staff). */
export enum Scope {
  Own = 'own',
  All = 'all',
}

export enum Permission {
  // --- Portal del cliente (customer) ---
  /**
   * Prealertar, y SOLO Paqueteria: avisar de una compra que viene en camino a
   * Miami. No habilita dar de alta transporte ni agenciamiento; para eso hace
   * falta `tramite.manage`, que el cliente no tiene. La regla la aplican el
   * schema (`prealertShipmentSchema` fija el tipo) y `shipmentsService.prealert`.
   */
  PrealertCreate = 'prealert.create',
  PackageReadOwn = 'package.read.own',
  PackagePay = 'package.pay',
  /**
   * Ver los tramites PROPIOS que no son de Paqueteria (aereo, maritimo,
   * agenciamiento). Va aparte de `package.read.own` porque abre un modulo
   * distinto del menu del cliente ("Otros tramites"): prealertar es una accion
   * de Paqueteria y esos tramites no caben en "Mis paquetes".
   *
   * Es SOLO LECTURA. Ese modulo no tiene alta: quien registra un tramite de
   * transporte o agenciamiento es el staff con `tramite.manage`.
   */
  TramiteReadOwn = 'tramite.read.own',
  LockerRead = 'locker.read',
  ProfileWrite = 'profile.write',

  // --- Panel administrador (staff) ---
  DashboardRead = 'dashboard.read',
  PackageReceive = 'package.receive',
  PackageRead = 'package.read',
  PackageWrite = 'package.write',
  PackageReassign = 'package.reassign',
  TramiteManage = 'tramite.manage',
  /**
   * Corregir el estado de un tramite fuera de la maquina (retroceder o saltar) y
   * reversar unos costos ya aprobados. Son las dos unicas puertas para enmendar
   * un error, y ninguna forma parte del proceso: por eso van juntas en un permiso
   * aparte que solo tiene `admin`. Ver `transitionsService.correct`.
   */
  ShipmentCorrect = 'shipment.correct',
  CostsManage = 'costs.manage',
  CostsTramiteManage = 'costs.tramite.manage',
  /**
   * Fijar la tasa de cambio del sistema. La tasa es un VALOR GENERAL, no un dato
   * de cada tramite: quien carga costos la USA, no la decide. Por eso va aparte
   * de `costs.manage`. Ver `EXCHANGE_RATE_IS_GLOBAL`.
   *
   * Hoy solo lo tiene `admin`, pero nada en el codigo lo ata a ese rol: todo el
   * sistema pregunta por el PERMISO (`canSetExchangeRate`), asi que sumarlo a
   * otro rol le abre la pantalla de Configuración y le desbloquea el campo sin
   * tocar una linea mas.
   */
  ExchangeRateWrite = 'exchange_rate.write',
  /**
   * Fijar la tarifa de transporte internacional (USD por libra) con la que el
   * reporte de Paqueteria calcula el campo 21.
   *
   * Es un valor general del sistema, igual que la tasa de cambio, y por eso vive
   * en la misma pantalla y sigue el mismo patron: permiso propio para poder
   * abrirlo a otro rol sin regalarle tambien la tasa.
   */
  FreightRateWrite = 'freight_rate.write',
  CostServicesManage = 'cost_services.manage',
  PaymentsValidate = 'payments.validate',
  DeliveryManage = 'delivery.manage',
  ReportsOperationalBasic = 'reports.operational.basic',
  ReportsOperationalFull = 'reports.operational.full',
  ReportsFinancial = 'reports.financial',
  /**
   * Reportes FULL por servicio (Paqueteria y Agenciamiento): el juego COMPLETO
   * de columnas, costos y margen incluidos.
   *
   * Va aparte de `reports.operational.full` y no encima de el porque no es "mas
   * detalle operativo": es la rentabilidad del negocio. Solo `admin`, tal como lo
   * fija el mapeo de campos ("Solo los administradores tienen acceso a esto").
   */
  ReportsFull = 'reports.full',
  /**
   * Reportes operativos por servicio: los mismos tramites SIN las columnas de
   * costo, margen ni porcentaje (Paqueteria hasta el campo 15, Agenciamiento
   * hasta el 18). Incluye el monto de factura, que es lo que lo separa del
   * basico y la razon de que sea un permiso propio y no el mismo.
   */
  ReportsOperational = 'reports.operational',
  /**
   * Generar la proforma de un tramite. Es un DOCUMENTO para el cliente, no una
   * consulta, y ese es el motivo de que no cuelgue de ningun reporte: quien
   * puede leer cifras no necesariamente puede emitir papel a nombre de la
   * empresa. Administrador y Financiero.
   */
  ReportsProforma = 'reports.proforma',
  ClientsRead = 'clients.read',
  ClientsWrite = 'clients.write',
  ConfigManage = 'config.manage',
  TariffsManage = 'tariffs.manage',
  RoutesManage = 'routes.manage',
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
  // Resource.Tramite y no Package: es la entrada "Otros tramites" del menu del
  // cliente, el mismo modulo que el staff ve como "Tramites". El alcance real de
  // la consulta lo pone la sesion (`ownerScopeFor`), igual que package.read.own.
  [Permission.TramiteReadOwn]: { resource: Resource.Tramite, action: Action.Read, scope: Scope.Own },
  [Permission.LockerRead]: { resource: Resource.Locker, action: Action.Read, scope: Scope.Own },
  [Permission.ProfileWrite]: { resource: Resource.Profile, action: Action.Write, scope: Scope.Own },

  [Permission.DashboardRead]: { resource: Resource.Dashboard, action: Action.Read, scope: Scope.All },
  [Permission.PackageReceive]: { resource: Resource.Reception, action: Action.Receive, scope: Scope.All },
  [Permission.PackageRead]: { resource: Resource.Package, action: Action.Read, scope: Scope.All },
  [Permission.PackageWrite]: { resource: Resource.Package, action: Action.Write, scope: Scope.All },
  [Permission.PackageReassign]: { resource: Resource.Package, action: Action.Reassign, scope: Scope.All },
  [Permission.TramiteManage]: { resource: Resource.Tramite, action: Action.Manage, scope: Scope.All },
  // Resource.Package y no uno nuevo: corregir no es un modulo del menu, es una
  // accion excepcional sobre el tramite (de cualquier tipo).
  [Permission.ShipmentCorrect]: { resource: Resource.Package, action: Action.Correct, scope: Scope.All },
  [Permission.CostsManage]: { resource: Resource.Costs, action: Action.Manage, scope: Scope.All },
  [Permission.CostsTramiteManage]: { resource: Resource.Costs, action: Action.Manage, scope: Scope.All },
  // Resource.Settings: fijar la tasa SI abre un modulo del menu (Configuración),
  // que es donde se decide el valor general. La pantalla de costos solo lo usa.
  [Permission.ExchangeRateWrite]: { resource: Resource.Settings, action: Action.Write, scope: Scope.All },
  [Permission.FreightRateWrite]: { resource: Resource.Settings, action: Action.Write, scope: Scope.All },
  [Permission.CostServicesManage]: { resource: Resource.CostServices, action: Action.Manage, scope: Scope.All },
  [Permission.PaymentsValidate]: { resource: Resource.Payments, action: Action.Validate, scope: Scope.All },
  [Permission.DeliveryManage]: { resource: Resource.Delivery, action: Action.Manage, scope: Scope.All },
  [Permission.ReportsOperationalBasic]: { resource: Resource.Reports, action: Action.Generate, scope: Scope.All },
  [Permission.ReportsOperationalFull]: { resource: Resource.Reports, action: Action.Generate, scope: Scope.All },
  [Permission.ReportsFinancial]: { resource: Resource.Reports, action: Action.Generate, scope: Scope.All },
  [Permission.ReportsFull]: { resource: Resource.Reports, action: Action.Generate, scope: Scope.All },
  [Permission.ReportsOperational]: { resource: Resource.Reports, action: Action.Generate, scope: Scope.All },
  [Permission.ReportsProforma]: { resource: Resource.Reports, action: Action.Generate, scope: Scope.All },
  [Permission.ClientsRead]: { resource: Resource.Clients, action: Action.Read, scope: Scope.All },
  [Permission.ClientsWrite]: { resource: Resource.Clients, action: Action.Write, scope: Scope.All },
  [Permission.ConfigManage]: { resource: Resource.Config, action: Action.Manage, scope: Scope.All },
  [Permission.TariffsManage]: { resource: Resource.Tariffs, action: Action.Manage, scope: Scope.All },
  [Permission.RoutesManage]: { resource: Resource.Routes, action: Action.Manage, scope: Scope.All },
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
  // Solo admin: es la puerta para deshacer, no para operar.
  Permission.ShipmentCorrect,
  Permission.CostsManage,
  Permission.CostsTramiteManage,
  // Solo admin: son valores generales del sistema, no datos del tramite.
  Permission.ExchangeRateWrite,
  Permission.FreightRateWrite,
  Permission.CostServicesManage,
  Permission.PaymentsValidate,
  Permission.DeliveryManage,
  Permission.ReportsOperationalBasic,
  Permission.ReportsOperationalFull,
  Permission.ReportsFinancial,
  Permission.ReportsFull,
  Permission.ReportsOperational,
  Permission.ReportsProforma,
  Permission.ClientsRead,
  Permission.ClientsWrite,
  Permission.ConfigManage,
  Permission.TariffsManage,
  Permission.RoutesManage,
  Permission.UsersManage,
  Permission.AnnouncementsManage,
];

/** Relacion Role -> Permission[]. Matriz literal de docs/roles.md §2. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  [Role.Client]: [
    Permission.PrealertCreate,
    Permission.PackageReadOwn,
    Permission.PackagePay,
    Permission.TramiteReadOwn,
    Permission.LockerRead,
    Permission.ProfileWrite,
  ],

  [Role.Admin]: ADMIN_PERMISSIONS,

  [Role.ServicioCliente]: [
    Permission.DashboardRead,
    Permission.PackageRead,
    Permission.ReportsOperationalBasic,
    // Atender a un cliente incluye responderle cuanto se le facturo; lo que no ve
    // es lo que a HS Global le costo (eso es `reports.full`).
    Permission.ReportsOperational,
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
    Permission.ReportsOperational,
    Permission.ClientsRead,
  ],

  // Financiero emite proformas pero NO ve el reporte FULL: cobrar es su trabajo,
  // la rentabilidad del negocio no.
  [Role.Financiero]: [
    Permission.PackageRead,
    Permission.ReportsFinancial,
    Permission.ReportsProforma,
  ],

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
