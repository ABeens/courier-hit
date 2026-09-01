/**
 * En que moneda esta escrita una factura, que es la moneda en la que hay que
 * imprimir su proforma.
 *
 * La regla de negocio que defiende: un agenciamiento se carga en colones y el
 * documento que recibe el cliente tiene que hablarle en colones. El sistema sabe
 * convertir a dolares (la tasa viaja en cada linea), pero convertir NO es lo
 * mismo que reexpresar el cobro: entregarle al cliente una cifra que el nunca
 * digito le obliga a rehacer la cuenta para reconocer su propia factura.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Currency } from '../money/currency';
import { CostCategory } from './cost-service';
import { computeTotals, invoiceCurrency, totalIn } from './shipment-cost';

/** Linea minima para totalizar: importe, moneda y su tasa (regla M5). */
function line(amount: number, currency: Currency, exchangeRate = 500) {
  return { amount, currency, exchangeRate, category: CostCategory.Otros };
}

test('agenciamiento cargado en colones: el documento es en colones', () => {
  const lines = [line(60_000, Currency.CRC), line(15_000, Currency.CRC)];
  assert.equal(invoiceCurrency(lines), Currency.CRC);
});

test('paqueteria cargada en dolares: el documento es en dolares', () => {
  const lines = [line(25, Currency.USD), line(4.5, Currency.USD)];
  assert.equal(invoiceCurrency(lines), Currency.USD);
});

test('con lineas mezcladas manda la moneda que concentra el mayor importe', () => {
  // ₡100 000 son $200 a 500: pesan mas que los $30 de la otra linea.
  const lines = [line(30, Currency.USD), line(100_000, Currency.CRC)];
  assert.equal(invoiceCurrency(lines), Currency.CRC);
});

test('el empate lo resuelve la primera linea, que es la que fijo la moneda', () => {
  // $100 y ₡50 000 valen lo mismo a 500 colones por dolar.
  assert.equal(invoiceCurrency([line(100, Currency.USD), line(50_000, Currency.CRC)]), Currency.USD);
  assert.equal(invoiceCurrency([line(50_000, Currency.CRC), line(100, Currency.USD)]), Currency.CRC);
});

test('una factura en cero no cambia de moneda sola: sigue siendo la de sus lineas', () => {
  assert.equal(invoiceCurrency([line(0, Currency.CRC)]), Currency.CRC);
});

test('sin lineas se responde dolares, aunque ese caso no llega a imprimirse', () => {
  assert.equal(invoiceCurrency([]), Currency.USD);
});

test('el total del documento es el mismo numero, se pida en la moneda que se pida', () => {
  const lines = [line(60_000, Currency.CRC), line(20, Currency.USD)];
  const totals = computeTotals(lines);

  assert.equal(totalIn(totals, Currency.CRC), totals.crc);
  assert.equal(totalIn(totals, Currency.USD), totals.usd);
  // ₡60 000 + $20 (= ₡10 000) = ₡70 000 = $140 a 500.
  assert.equal(totals.crc, 70_000);
  assert.equal(totals.usd, 140);
});
