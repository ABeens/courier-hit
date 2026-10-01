/**
 * El tipo de una correccion se reconoce por el texto fijo que escribe cada
 * puerta. Estos casos copian esas notas tal cual: si una puerta cambia su texto
 * sin tocar `CORRECTION_KIND_PATTERNS`, la auditoria las clasificaria mal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Role } from '../auth/roles';
import { Permission, can } from '../auth/permissions';
import { CORRECTION_NOTE_PREFIX } from '../shipments/shipment';
import { CorrectionKind, correctionKindOf } from './dto';

const p = CORRECTION_NOTE_PREFIX;

test('cada puerta de correccion se reconoce por su texto', () => {
  assert.equal(correctionKindOf(`${p}proforma PF-000123 devuelta a borrador. Monto mal`), CorrectionKind.Proforma);
  assert.equal(correctionKindOf(`${p}dueño cambiado de sin dueño a HS123 (Ana). Llamó la clienta`), CorrectionKind.Dueno);
  assert.equal(correctionKindOf(`${p}paquete descartado. Duplicado`), CorrectionKind.Descarte);
  assert.equal(
    correctionKindOf(`${p}descarte deshecho: el paquete vuelve a la sala de control.`),
    CorrectionKind.DescarteDeshecho,
  );
  assert.equal(
    correctionKindOf(`${p}paquete encontrado en bodega sin aviso previo. Registrado sin dueño desde la sala de control.`),
    CorrectionKind.RegistroSinDueno,
  );
});

test('la nota libre de corregir estado cae en Estado', () => {
  assert.equal(correctionKindOf(`${p}salió a ruta y nadie lo marcó`), CorrectionKind.Estado);
  assert.equal(correctionKindOf(`${p}la proforma estaba bien`), CorrectionKind.Estado);
});

test('la auditoria es solo del administrador', () => {
  assert.equal(can(Role.Admin, Permission.AuditRead), true);
  for (const role of Object.values(Role).filter((r) => r !== Role.Admin)) {
    assert.equal(can(role, Permission.AuditRead), false, role);
  }
});
