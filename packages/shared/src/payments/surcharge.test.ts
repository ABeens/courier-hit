/**
 * El desglose del cobro con tarjeta. Se prueba aparte porque de el sale el
 * importe que el cliente acepta, el que se le manda a la pasarela y el que queda
 * guardado: si la cuenta no cierra, la empresa cobra de menos en cada tarjeta.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Currency } from '../money/currency';
import { DEFAULT_CARD_SURCHARGE, cardChargeFor, splitAmount } from './surcharge';

/** Lo que la pasarela se queda de un cobro: su porcentaje del total, mas el fijo. */
function gatewayFee(total: number, fixed: number): number {
  return (total * DEFAULT_CARD_SURCHARGE.percent) / 100 + fixed;
}

test('el total cobrado deja neto el saldo facturado (gross-up, no recargo simple)', () => {
  const charge = cardChargeFor(100, Currency.USD, 500);
  assert.equal(charge.amount, 100);
  assert.equal(charge.total, 104.43);
  assert.equal(charge.surcharge, 4.43);
  // Lo que queda despues de la comision no baja del saldo: la empresa no pone nada.
  assert.ok(charge.total - gatewayFee(charge.total, DEFAULT_CARD_SURCHARGE.fixedUsd) >= 100);
});

test('un recargo simple (saldo x 3,9 % + fijo) se quedaria corto', () => {
  const naive = 100 * (1 + DEFAULT_CARD_SURCHARGE.percent / 100) + DEFAULT_CARD_SURCHARGE.fixedUsd;
  assert.ok(naive - gatewayFee(naive, DEFAULT_CARD_SURCHARGE.fixedUsd) < 100);
});

test('en colones el fijo en dolares se convierte con la tasa del cobro', () => {
  const charge = cardChargeFor(50_000, Currency.CRC, 500);
  // ₡175 es el equivalente de $0,35 a 500, y el colon no lleva centimos.
  assert.equal(charge.total, Math.ceil((50_000 + 175) / (1 - DEFAULT_CARD_SURCHARGE.percent / 100)));
  assert.equal(charge.surcharge, charge.total - 50_000);
  assert.ok(charge.total - gatewayFee(charge.total, 175) >= 50_000);
});

test('el total redondea HACIA ARRIBA: nunca por debajo de la comision', () => {
  // 10.01 despeja a 10.7818…, que redondeado al mas cercano (10.78) deja corto.
  const charge = cardChargeFor(10.01, Currency.USD, 500);
  assert.equal(charge.total, 10.79);
  assert.ok(charge.total - gatewayFee(charge.total, DEFAULT_CARD_SURCHARGE.fixedUsd) >= 10.01);
});

test('sin saldo no hay comision que trasladar', () => {
  assert.deepEqual(cardChargeFor(0, Currency.USD, 500), {
    currency: Currency.USD,
    amount: 0,
    surcharge: 0,
    total: 0,
  });
});

test('un saldo negativo no genera cobro (regla M3: montos >= 0)', () => {
  const charge = cardChargeFor(-40, Currency.USD, 500);
  assert.equal(charge.amount, 0);
  assert.equal(charge.total, 0);
});

test('una comision del 100 % no tiene despeje: falla en vez de cobrar un absurdo', () => {
  assert.throws(() => cardChargeFor(100, Currency.USD, 500, { percent: 100, fixedUsd: 0 }));
});

test('el reparto de la comision suma exactamente el total', () => {
  const parts = splitAmount(9.18, [217.09, 80, 33.33], Currency.USD);
  assert.equal(
    parts.reduce((a, b) => a + b, 0).toFixed(2),
    '9.18',
  );
});

test('las unidades sueltas van a los restos mayores, no a la primera parte', () => {
  // 0.10 entre tres partes iguales: 0.04 / 0.03 / 0.03, nunca 0.10 / 0 / 0.
  assert.deepEqual(splitAmount(0.1, [1, 1, 1], Currency.USD), [0.04, 0.03, 0.03]);
});

test('en colones reparte unidades enteras: ningun centimo que no existe', () => {
  const parts = splitAmount(5055, [70_000, 50_000], Currency.CRC);
  assert.deepEqual(parts, [2949, 2106]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 5055);
});

test('sin pesos (todo en cero) el importe no se pierde', () => {
  assert.deepEqual(splitAmount(4.5, [0, 0], Currency.USD), [4.5, 0]);
});

test('sin partes no hay reparto', () => {
  assert.deepEqual(splitAmount(4.5, [], Currency.USD), []);
});
