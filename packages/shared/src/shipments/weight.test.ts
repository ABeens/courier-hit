/**
 * Peso facturable segun el TIPO de tarifa.
 *
 * Es la unica diferencia de cobro entre una tarifa estandar y una consolidada, y
 * se prueba aparte porque el requisito acota las dos mitades: la consolidada
 * cobra el peso real, y las tarifas de siempre (basica, premium, VIP) NO cambian
 * su redondeo. Un caso mal resuelto aqui le cambia el precio a todos los clientes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClientRateKind } from '../tariffs/dto';
import { billableWeightKg, roundWeightKg } from './shipment';

test('tarifa estandar: el kilo se sigue redondeando hacia arriba (1.1 => 2)', () => {
  assert.equal(billableWeightKg(1.1, ClientRateKind.Estandar), 2);
});

test('tarifa estandar: un peso exacto no se infla', () => {
  assert.equal(billableWeightKg(3, ClientRateKind.Estandar), 3);
});

test('tarifa consolidada: se cobra el peso REAL, sin redondear', () => {
  assert.equal(billableWeightKg(1.1, ClientRateKind.Consolidada), 1.1);
});

test('tarifa consolidada: tampoco se redondea un peso de gramos', () => {
  assert.equal(billableWeightKg(0.35, ClientRateKind.Consolidada), 0.35);
});

test('el redondeo estandar sigue siendo el del manual', () => {
  assert.equal(roundWeightKg(1.1), 2);
  assert.equal(roundWeightKg(2), 2);
});
