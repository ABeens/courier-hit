/**
 * Rango obligatorio y tope de meses de los reportes. Se prueba la regla del
 * esquema porque la misma la aplica la pantalla antes de pedir: si cambia aqui
 * sin querer, la API y el portal dejan de coincidir.
 *
 * Runner: node:test. Correr con `pnpm --filter @courier/shared test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReportKind } from './report';
import { addUtcMonths, reportQuerySchema } from './dto';

const kind = Object.values(ReportKind)[0]!;

function parse(from?: string, to?: string) {
  return reportQuerySchema.safeParse({ kind, from, to });
}

test('addUtcMonths no desborda al mes siguiente en fin de mes', () => {
  assert.equal(addUtcMonths(new Date('2026-08-31T06:00:00Z'), 6).toISOString(), '2027-02-28T06:00:00.000Z');
  assert.equal(addUtcMonths(new Date('2026-05-01T06:00:00Z'), 6).toISOString(), '2026-11-01T06:00:00.000Z');
});

test('las fechas son obligatorias', () => {
  assert.equal(parse(undefined, '2026-11-01T06:00:00Z').success, false);
  assert.equal(parse('2026-10-01T06:00:00Z', undefined).success, false);
});

test('acepta exactamente seis meses (1 de mayo al 31 de octubre, hora de Costa Rica)', () => {
  assert.equal(parse('2026-05-01T06:00:00Z', '2026-11-01T06:00:00Z').success, true);
});

test('rechaza un dia mas de seis meses', () => {
  assert.equal(parse('2026-05-01T06:00:00Z', '2026-11-02T06:00:00Z').success, false);
});

test('rechaza un rango invertido o vacio', () => {
  assert.equal(parse('2026-10-10T06:00:00Z', '2026-10-01T06:00:00Z').success, false);
  assert.equal(parse('2026-10-10T06:00:00Z', '2026-10-10T06:00:00Z').success, false);
});
