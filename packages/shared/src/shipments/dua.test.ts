/**
 * Mascara del DUA (`formatDua`): el usuario digita solo numeros y los guiones los
 * pone el formato, sin que el resultado deje de pasar por `duaSchema`.
 *
 * Runner: node:test (integrado). Correr con `pnpm --filter @courier/shared test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DUA_LENGTH, duaSchema, formatDua } from './dto';

test('intercala los guiones a medida que se digita', () => {
  assert.equal(formatDua('1'), '1');
  assert.equal(formatDua('123'), '123');
  assert.equal(formatDua('1234'), '123-4');
  assert.equal(formatDua('1234567'), '123-4567');
  assert.equal(formatDua('12345678'), '123-4567-8');
  assert.equal(formatDua('1234567890123'), '123-4567-890123');
});

test('un bloque completo no arrastra guion suelto (para poder borrar hacia atras)', () => {
  assert.equal(formatDua('123'), '123');
  assert.equal(formatDua('123-4567'), '123-4567');
});

test('ignora lo que no sea digito: guiones ya escritos, espacios o letras', () => {
  assert.equal(formatDua('123-4567-890123'), '123-4567-890123');
  assert.equal(formatDua('123 4567 890123'), '123-4567-890123');
  assert.equal(formatDua('12a3'), '123');
  assert.equal(formatDua('abc'), '');
  assert.equal(formatDua(''), '');
});

test('corta el excedente de digitos', () => {
  assert.equal(formatDua('12345678901239999'), '123-4567-890123');
  assert.equal(formatDua('1234567890123').length, DUA_LENGTH);
});

test('el DUA completo que produce la mascara valida contra duaSchema', () => {
  assert.equal(duaSchema.safeParse(formatDua('1234567890123')).success, true);
  assert.equal(duaSchema.safeParse(formatDua('12345')).success, false); // incompleto
});
