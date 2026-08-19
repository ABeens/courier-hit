/**
 * Reglas de RBAC que no son una tabla sino una decision de negocio, y que por eso
 * se prueban aparte: la separacion entre REGISTRAR un deposito y APROBARLO, y el
 * alcance del rol Bodega (al final del archivo).
 *
 * Se prueba aparte porque es una regla de negocio, no una tabla: el Operativo
 * asienta el comprobante que le manda el cliente y el Administrador decide si
 * ese dinero entro. Cada caso que responda mal aqui es un paquete que sale a
 * ruta contra un deposito que nadie miro.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentStatus, recordedPaymentStatus } from '../payments/payment';
import {
  PERMISSION_DEFS,
  Permission,
  Resource,
  Scope,
  can,
  permissionsFor,
  resourcesFor,
} from './permissions';
import { Role } from './roles';

test('el Operativo puede registrar un deposito', () => {
  assert.equal(can(Role.Operativo, Permission.PaymentsRecord), true);
});

test('el Operativo NO puede aprobarlo: registrar no es cobrar', () => {
  assert.equal(can(Role.Operativo, Permission.PaymentsValidate), false);
});

test('el Administrador puede las dos cosas', () => {
  assert.equal(can(Role.Admin, Permission.PaymentsRecord), true);
  assert.equal(can(Role.Admin, Permission.PaymentsValidate), true);
});

test('ningun otro rol de staff registra pagos', () => {
  for (const role of [Role.ServicioCliente, Role.Financiero, Role.Mensajeria, Role.Bodega, Role.Client]) {
    assert.equal(can(role, Permission.PaymentsRecord), false, role);
    assert.equal(can(role, Permission.PaymentsValidate), false, role);
  }
});

test('lo que registra el Operativo nace EN VALIDACION', () => {
  assert.equal(recordedPaymentStatus(Role.Operativo), PaymentStatus.Pendiente);
});

test('lo que registra el Administrador nace confirmado: el mismo lo valida', () => {
  assert.equal(recordedPaymentStatus(Role.Admin), PaymentStatus.Confirmado);
});

/**
 * El desenlace sale del PERMISO, no del rol. Si algun dia `payments.validate` se
 * le da a otro rol, `recordedPaymentStatus` tiene que seguirlo sin tocarse; y
 * mientras no se le de, ningun rol nuevo puede colarse dejando abonos
 * confirmados.
 */
test('nace confirmado exactamente quien puede aprobar', () => {
  for (const role of Object.values(Role)) {
    assert.equal(
      recordedPaymentStatus(role) === PaymentStatus.Confirmado,
      can(role, Permission.PaymentsValidate),
      role,
    );
  }
});

/**
 * BODEGA: el rol que solo recibe.
 *
 * El criterio de aceptacion es literal ("solo posee la opcion de Registrar
 * paquetes en el menu de la izquierda") y aqui se prueba como lo que es: no una
 * lista de items pintados, sino el conjunto de RECURSOS que el rol abre, que es
 * de donde el menu se deriva (`resourcesFor`, ver PortalShell). Probar el menu
 * en el shell dejaria pasar el agujero de verdad, que es el deep-link
 * /app/<slug> a una pantalla que no le toca.
 */
test('Bodega abre un solo modulo: Recepcion', () => {
  assert.deepEqual([...resourcesFor(Role.Bodega)], [Resource.Reception]);
});

test('Bodega tiene exactamente un permiso: recibir', () => {
  assert.deepEqual([...permissionsFor(Role.Bodega)], [Permission.PackageReceive]);
});

/**
 * Lo que separa a Bodega de Operativo. Se enumera para que sumarle un permiso
 * sea una decision y no un descuido: si alguien le da el listado de Paqueteria o
 * los costos, este test cae.
 */
test('Bodega no opera el proceso: ni listado, ni estados, ni costos, ni resumen', () => {
  for (const permission of [
    Permission.PackageRead,
    Permission.PackageWrite,
    Permission.TramiteManage,
    Permission.CostsManage,
    Permission.DashboardRead,
    Permission.ClientsRead,
    Permission.ControlRoomManage,
  ]) {
    assert.equal(can(Role.Bodega, permission), false, permission);
  }
});

/**
 * Bodega es staff, y el staff nunca lleva permisos de alcance propio: si algun
 * dia se le colara uno, la API lo filtraria por dueño y el rol no tiene dueño.
 */
test('Bodega no lleva permisos de alcance propio', () => {
  for (const permission of permissionsFor(Role.Bodega)) {
    assert.equal(PERMISSION_DEFS[permission].scope, Scope.All, permission);
  }
});
