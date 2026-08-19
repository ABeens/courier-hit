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
   * Sala de control: los paquetes que llegaron a bodega SIN dueño conocido y la
   * reasignacion de dueño de un tramite ya registrado.
   *
   * Es un modulo propio y no una accion mas sobre Package porque tiene su propia
   * pantalla y su propia poblacion: el tablero de Paqueteria opera tramites que
   * fluyen, y esto es el cuarto de atras donde se arregla lo que entro mal. La
   * matriz del manual lo lista como fila aparte ("Paquetes — reasignar cliente
   * (desconocidos/homónimos)", docs/manuales/roles.md L38).
   */
  ControlRoom = 'control_room',
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
  /**
   * Sala de control: registrar un paquete que llego a bodega sin que nadie lo
   * anunciara, corregir sus datos, asignarle dueño (o cambiarselo a uno que ya lo
   * tiene) y descartarlo.
   *
   * Las cuatro acciones van en UN permiso porque son la misma pantalla y el mismo
   * acto: enmendar el registro de un paquete cuyo origen se perdio. Separarlas
   * daria roles que pueden dar de alta un desconocido pero no asignarlo, que es
   * dejar el trabajo a medias.
   *
   * Solo `admin`. Se evaluo darselo tambien a Servicio al Cliente, que es quien
   * recibe la llamada del paquete que no aparece, y a Operativo, que es quien
   * encuentra el bulto en bodega (la matriz del manual, docs/manuales/roles.md
   * L11 y L38, si se lo da a este ultimo). Se dejo en admin: estas acciones
   * enmiendan el registro por fuera del flujo, y quien las ejecuta responde por el
   * sistema, no lo opera.
   *
   * Abrirselo a otro rol es sumar este permiso en ROLE_PERMISSIONS y nada mas: la
   * pantalla, el menu y los endpoints preguntan por el PERMISO, nunca por el rol.
   */
  ControlRoomManage = 'control_room.manage',
  TramiteManage = 'tramite.manage',
  /**
   * Corregir el estado de un tramite fuera de la maquina (retroceder o saltar) y
   * reversar unos costos ya aprobados. Son las dos unicas puertas para enmendar
   * un error, y ninguna forma parte del proceso: por eso van juntas en un permiso
   * aparte de `control_room.manage`. Ver `transitionsService.correct`.
   *
   * Solo `admin`, igual que `control_room.manage`. Sigue siendo un permiso
   * SEPARADO de aquel aunque hoy los lleve el mismo rol: si mañana la sala se le
   * abre a Operativo, no se lleva de paso la puerta de saltarse la maquina.
   *
   * Desde que corregir el estado solo se ofrece DENTRO de la sala de control, este
   * permiso no alcanza por si solo para nada: hace falta ademas
   * `control_room.manage` para llegar a la pantalla. Lo unico que abre por su
   * cuenta es reversar la factura, y aun eso exige los permisos de costos que pide
   * su propio modulo (costs.routes.ts).
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
  /**
   * Registrar un deposito ya recibido contra un tramite ("Informacion de Pago"
   * del manual) y adjuntarle el comprobante.
   *
   * VA APARTE DE `payments.validate` PORQUE SON DOS ACTOS DISTINTOS. Registrar
   * es asentar lo que alguien dice que pago: el cliente le manda el comprobante
   * al operario y este lo mete al sistema con el archivo de respaldo. Aprobarlo
   * es dar el dinero por recibido contra el estado de cuenta, y de eso responde
   * el administrador. Con un solo permiso, abrirle el registro al operario le
   * regalaba de paso la aprobacion, que es justo lo que no puede tener.
   *
   * Lo llevan `admin` y `operativo`. Quien solo registra deja el abono
   * PENDIENTE (ver `recordedPaymentStatus`): el tramite queda "Pagado - en
   * validacion" y sigue sin cubrir Condition.RequiresConfirmedPayment, asi que
   * el paquete no sale a ruta por haberlo digitado.
   */
  PaymentsRecord = 'payments.record',
  /**
   * APROBAR o rechazar un deposito, y con eso decidir que el dinero entro. Solo
   * `admin`: es la puerta que convierte un comprobante en cobro.
   */
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
  // Resource.ControlRoom: SI abre un modulo del menu (la sala de control), a
  // diferencia de shipment.correct, que es una accion suelta sobre el tramite.
  [Permission.ControlRoomManage]: { resource: Resource.ControlRoom, action: Action.Reassign, scope: Scope.All },
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
  // Action.Create y no Validate: registrar es dar de alta el abono, no resolverlo.
  [Permission.PaymentsRecord]: { resource: Resource.Payments, action: Action.Create, scope: Scope.All },
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
  Permission.TramiteManage,
  // Solo admin: son las dos puertas para deshacer, no para operar.
  Permission.ShipmentCorrect,
  Permission.ControlRoomManage,
  Permission.CostsManage,
  Permission.CostsTramiteManage,
  // Solo admin: son valores generales del sistema, no datos del tramite.
  Permission.ExchangeRateWrite,
  Permission.FreightRateWrite,
  Permission.CostServicesManage,
  Permission.PaymentsRecord,
  // Solo admin: aprobar el deposito es dar el dinero por recibido.
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

  // Opera el proceso de punta a punta: recibe en bodega, mueve los estados de
  // Paqueteria y de Transporte (`package.write`) y los de Agenciamiento
  // (`tramite.manage`), carga los costos de Paqueteria y Transporte, y asienta
  // los depositos que el cliente le manda (`payments.record`).
  //
  // Lo que NO lleva, y por eso no aparece aqui: los costos de Agenciamiento
  // (`costs.tramite.manage`, los servicios manuales que negocia el admin), la
  // entrega (`delivery.manage`, que es Mensajeria) y la APROBACION de esos
  // depositos (`payments.validate`). Un tramite de Agenciamiento avanza con este
  // rol hasta "Proceso de Aduanas"; facturarlo es la puerta donde pasa a manos
  // del administrador, igual que Paqueteria le pasa el paquete al mensajero en
  // "En bodega - Pendiente pago" y el deposito le pasa al administrador en
  // "Pagado - en validacion".
  [Role.Operativo]: [
    Permission.DashboardRead,
    Permission.PackageReceive,
    Permission.PackageRead,
    Permission.PackageWrite,
    Permission.TramiteManage,
    Permission.CostsManage,
    Permission.PaymentsRecord,
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

  /**
   * Bodega: UN solo permiso, y por eso un solo modulo en el menu (Recepcion).
   * `resourcesFor` deriva el menu de los permisos, asi que la lista de abajo ES
   * la regla "solo ve Registrar paquetes": no hay que tocar el menu.
   *
   * Lo que NO lleva, y no por olvido: `package.read` (el listado de Paqueteria),
   * `package.write` (mover estados), `costs.manage` y `dashboard.read`. Todo eso
   * es lo que separa a Bodega de Operativo, que hace el proceso entero; aqui el
   * trabajo empieza y termina en la mesa: llega el bulto, se escanea, listo.
   *
   * Tampoco lleva `control_room.manage`, que es lo que en Recepcion abre el
   * atajo de dar de alta un LES desconocido (ver `canRegisterUnassigned`): un
   * paquete que nadie anuncio se enmienda en la sala de control, y de eso
   * responde el administrador. Con este rol la bitacora dice «Ingresar manual» y
   * ahi se acaba.
   */
  [Role.Bodega]: [Permission.PackageReceive],
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
