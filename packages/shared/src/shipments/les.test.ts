/**
 * Formato del consecutivo LES que acepta Recepcion en bodega (`lesSchema`):
 * empieza por "LES" y tiene al menos 4 caracteres.
 *
 * Runner: node:test (integrado). Correr con `pnpm --filter @courier/shared test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LES_MIN_LENGTH, LES_PREFIX, lesSchema, receiveShipmentSchema } from './dto';

function firstMessage(value: string): string | undefined {
  const parsed = lesSchema.safeParse(value);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

test('acepta el consecutivo tal como lo imprime la bodega', () => {
  assert.equal(lesSchema.safeParse('LES48450141').success, true);
  assert.equal(lesSchema.safeParse('LES1').success, true); // el minimo: prefijo + 1
  assert.equal(lesSchema.safeParse('LES-2026-001').success, true);
});

test('normaliza espacios y mayusculas antes de validar', () => {
  assert.equal(lesSchema.parse('  les48450141  '), 'LES48450141');
  assert.equal(receiveShipmentSchema.parse({ hawb: 'les1' }).hawb, 'LES1');
});

test('rechaza lo que no empieza por LES, con su mensaje', () => {
  assert.equal(firstMessage('48450141'), `El LES debe comenzar por ${LES_PREFIX}.`);
  assert.equal(firstMessage('1Z999AA10123456784'), `El LES debe comenzar por ${LES_PREFIX}.`);
  assert.equal(firstMessage('LE48450141'), `El LES debe comenzar por ${LES_PREFIX}.`);
});

test('rechaza el prefijo solo: hacen falta al menos 4 caracteres', () => {
  assert.equal(firstMessage('LES'), `El LES debe tener al menos ${LES_MIN_LENGTH} caracteres.`);
  assert.equal(firstMessage(' les '), `El LES debe tener al menos ${LES_MIN_LENGTH} caracteres.`);
});

test('el campo vacio tiene su propio aviso', () => {
  assert.equal(firstMessage(''), 'Escanea o digita el LES.');
  assert.equal(firstMessage('   '), 'Escanea o digita el LES.');
});

test('rechaza caracteres fuera de letras, numeros y guiones', () => {
  assert.equal(firstMessage('LES 4845'), 'El LES solo admite letras, números y guiones.');
  assert.equal(firstMessage('LES#4845'), 'El LES solo admite letras, números y guiones.');
});
