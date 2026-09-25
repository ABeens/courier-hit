/**
 * Cuando toca el correo diario. Las fechas van en UTC; Costa Rica es UTC-6 todo
 * el año (no cambia de horario), asi que las 6:00 locales son las 12:00 UTC.
 *
 * Runner: node:test. Correr con `pnpm --filter @courier/shared test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDailyDigestDue, localDayAndHour } from './daily-digest-dto';

test('la hora local de Costa Rica es UTC-6', () => {
  assert.deepEqual(localDayAndHour(new Date('2026-09-24T12:00:00Z'), 'America/Costa_Rica'), {
    day: '2026-09-24',
    hour: 6,
  });
});

test('antes de la hora configurada no toca', () => {
  assert.equal(isDailyDigestDue(new Date('2026-09-24T11:59:00Z'), 6, null), false);
});

test('a la hora configurada toca si nunca se envio', () => {
  assert.equal(isDailyDigestDue(new Date('2026-09-24T12:00:00Z'), 6, null), true);
});

test('no se envia dos veces el mismo dia', () => {
  const sentToday = new Date('2026-09-24T12:03:00Z');
  assert.equal(isDailyDigestDue(new Date('2026-09-24T18:00:00Z'), 6, sentToday), false);
});

test('al dia siguiente vuelve a tocar', () => {
  const sentYesterday = new Date('2026-09-23T12:03:00Z');
  assert.equal(isDailyDigestDue(new Date('2026-09-24T12:00:00Z'), 6, sentYesterday), true);
});

test('si el robot estuvo caido a la hora, lo manda en cuanto vuelve ese mismo dia', () => {
  const sentYesterday = new Date('2026-09-23T12:03:00Z');
  assert.equal(isDailyDigestDue(new Date('2026-09-24T20:00:00Z'), 6, sentYesterday), true);
});

test('el dia local cambia a medianoche de Costa Rica, no de UTC', () => {
  // 23:30 local del 23 = 05:30 UTC del 24: sigue siendo el 23 en Costa Rica.
  const sentLate = new Date('2026-09-24T05:30:00Z');
  assert.equal(isDailyDigestDue(new Date('2026-09-24T12:00:00Z'), 6, sentLate), true);
});
