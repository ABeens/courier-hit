/**
 * Linea "Apto / Suite" de la direccion de envio: casillero de la cuenta padre.
 *
 * Runner: node:test. Correr con `pnpm --filter @courier/shared test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatParentLocker, lockerAddressFor, MIAMI_WAREHOUSE, parentLockerOf } from './locker';

const suite = (parent?: string) =>
  lockerAddressFor('Ana', 'HS-1000', MIAMI_WAREHOUSE, parent).find((l) => l.label === 'Apto / Suite')!.value;

test('la cuenta padre sale del sub-casillero', () => {
  assert.equal(parentLockerOf('SJO008835S033'), 'SJO008835');
  assert.equal(parentLockerOf('SJO009623'), 'SJO009623');
  assert.equal(parentLockerOf(null), null);
  assert.equal(parentLockerOf('basura'), null);
});

test('el prefijo va separado del numero', () => {
  assert.equal(formatParentLocker('SJO008835'), 'SJO 008835');
});

test('la suite lleva el casillero de la cuenta padre', () => {
  assert.equal(suite(), 'Suite 700 SJO 008835');
  assert.equal(suite('SJO009623'), 'Suite 700 SJO 009623');
});

test('una suite configurada sin casillero igual lo recibe', () => {
  const lines = lockerAddressFor('Ana', 'HS-1000', { ...MIAMI_WAREHOUSE, addressLine2: 'Suite 700' }, 'SJO009623');
  assert.equal(lines[2]!.value, 'Suite 700 SJO 009623');
});
