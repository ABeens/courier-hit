/**
 * Reglas del cobro AGRUPADO que no dependen de la base de datos.
 *
 * `paymentGroupStatus` se prueba aparte porque es la unica respuesta a "¿este
 * cobro consolidado ya entro?": la consultan el documento (para no imprimir
 * "pagado" sobre un pendiente), la espera del cobro con tarjeta y la bandeja del
 * staff. Un caso mal resuelto aqui es un cobro que se anuncia cobrado sin serlo.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentStatus } from './payment';
import { paymentGroupStatus } from './consolidated';

test('un grupo con todos sus abonos confirmados esta confirmado', () => {
  assert.equal(
    paymentGroupStatus([PaymentStatus.Confirmado, PaymentStatus.Confirmado]),
    PaymentStatus.Confirmado,
  );
});

test('un solo abono sin validar deja el grupo entero pendiente', () => {
  assert.equal(
    paymentGroupStatus([PaymentStatus.Confirmado, PaymentStatus.Pendiente]),
    PaymentStatus.Pendiente,
  );
});

test('un rechazo tumba el grupo entero: el cobro era uno solo', () => {
  assert.equal(
    paymentGroupStatus([PaymentStatus.Confirmado, PaymentStatus.Rechazado]),
    PaymentStatus.Rechazado,
  );
});

test('el rechazo manda sobre el pendiente', () => {
  assert.equal(
    paymentGroupStatus([PaymentStatus.Pendiente, PaymentStatus.Rechazado]),
    PaymentStatus.Rechazado,
  );
});

test('un formulario de tarjeta abierto y sin usar es un grupo INICIADO, no un abono', () => {
  assert.equal(
    paymentGroupStatus([PaymentStatus.Iniciado, PaymentStatus.Iniciado]),
    PaymentStatus.Iniciado,
  );
});

test('iniciado manda sobre pendiente: mientras algo no ha salido, el cobro no esta en camino', () => {
  assert.equal(
    paymentGroupStatus([PaymentStatus.Iniciado, PaymentStatus.Pendiente]),
    PaymentStatus.Iniciado,
  );
});

test('un grupo sin abonos no cobro nada', () => {
  assert.equal(paymentGroupStatus([]), PaymentStatus.Rechazado);
});
