/**
 * Que moneda propone un catalogo de servicios: es con la que nace la proforma de
 * Transporte y Agenciamiento, antes de que el operador elija otra.
 *
 * La regla que defiende: la moneda no puede depender del orden del catalogo (que
 * es el de alta). Manda la mayoria de los servicios con moneda, y si no hay una
 * mayoria clara el catalogo no propone nada.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Currency } from '../money/currency';
import { proposedCurrency } from './cost-service';

const service = (currency: Currency | null) => ({ currency });

test('manda la moneda de la mayoria de los servicios', () => {
  const catalog = [service(Currency.USD), service(Currency.CRC), service(Currency.USD)];
  assert.equal(proposedCurrency(catalog), Currency.USD);
});

test('el orden no cambia la respuesta', () => {
  const catalog = [service(Currency.CRC), service(Currency.USD), service(Currency.CRC)];
  assert.equal(proposedCurrency(catalog), Currency.CRC);
  assert.equal(proposedCurrency([...catalog].reverse()), Currency.CRC);
});

test('los servicios sin moneda (porcentaje, manual) no votan', () => {
  const catalog = [service(null), service(null), service(Currency.USD)];
  assert.equal(proposedCurrency(catalog), Currency.USD);
});

test('sin servicios con moneda, o con empate, no propone nada', () => {
  assert.equal(proposedCurrency([]), null);
  assert.equal(proposedCurrency([service(null)]), null);
  assert.equal(proposedCurrency([service(Currency.USD), service(Currency.CRC)]), null);
});
