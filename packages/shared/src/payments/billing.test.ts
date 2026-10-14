/**
 * En que moneda se le habla del cobro a cada quien, y que cifra sale de ahi.
 *
 * Se prueba aparte de `awaitsValidation` porque responde otra pregunta: no si el
 * tramite admite otro pago, sino como se LEE lo que debe. La regla de negocio que
 * defiende es que al cliente el saldo se le dice en la moneda en que se le cobra
 * y nunca convertido a la otra.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Role } from '../auth/roles';
import { Currency } from '../money/currency';
import { ShipmentType } from '../workflow/shipment-type';
import { billingAmounts, billingCurrencyFor, chargeCurrencyOf } from './payment';
import type { BillingFigures } from './payment';

/** Factura de $100 a 500 colones por dolar, con la mitad abonada. */
const HALF_PAID: BillingFigures = {
  invoiceTotalUsd: 100,
  invoiceTotalCrc: 50_000,
  settledUsd: 50,
  settledCrc: 25_000,
  pendingUsd: 0,
  pendingCrc: 0,
};

test('al cliente se le habla en la moneda en que se le cobra', () => {
  assert.equal(billingCurrencyFor(Currency.USD, Role.Client), Currency.USD);
  assert.equal(billingCurrencyFor(Currency.CRC, Role.Client), Currency.CRC);
});

test('un transporte cuya proforma se cobra en dolares se le dice en dolares', () => {
  const charge = chargeCurrencyOf({ shipmentType: ShipmentType.Aereo, proformaCurrency: Currency.USD });
  assert.equal(billingCurrencyFor(charge, Role.Client), Currency.USD);
});

test('al staff todo se le presenta en colones, aunque se cobre en dolares', () => {
  // Es la moneda de cobro local: la que cuadra contra el banco.
  assert.equal(billingCurrencyFor(Currency.USD, Role.Admin), Currency.CRC);
});

test('la proyeccion en dolares toma la columna en dolares, sin reconvertir', () => {
  const amounts = billingAmounts(HALF_PAID, Currency.USD, false);
  assert.deepEqual(amounts, {
    currency: Currency.USD,
    invoiceTotal: 100,
    paid: 50,
    pending: 0,
    due: 50,
  });
});

test('la misma factura en colones da la columna en colones', () => {
  assert.equal(billingAmounts(HALF_PAID, Currency.CRC, false).due, 25_000);
});

test('un tramite saldado muestra saldo cero, aunque las columnas discrepen', () => {
  // Lo cubierto lo decide `isSettled` en colones; un centavo suelto en la columna
  // en dolares no puede contradecir a la bandera que dice "Pagado".
  const almost: BillingFigures = { ...HALF_PAID, settledUsd: 99.99, settledCrc: 50_000 };
  assert.equal(billingAmounts(almost, Currency.USD, true).due, 0);
});

test('una deuda abierta nunca se lee como cero', () => {
  // ₡1 de saldo son $0.002: redondeado seria "$0.00" y el cliente entenderia que
  // no debe nada, mientras el paquete se le sigue reteniendo.
  const crumb: BillingFigures = { ...HALF_PAID, settledUsd: 100, settledCrc: 49_999 };
  assert.equal(billingAmounts(crumb, Currency.USD, false).due, 0.01);
  assert.equal(billingAmounts(crumb, Currency.CRC, false).due, 1);
});

test('sin factura aprobada no hay nada que cobrar en ninguna moneda', () => {
  const unbilled: BillingFigures = {
    invoiceTotalUsd: null,
    invoiceTotalCrc: null,
    settledUsd: 0,
    settledCrc: 0,
    pendingUsd: 0,
    pendingCrc: 0,
  };
  assert.equal(billingAmounts(unbilled, Currency.USD, false).due, 0);
  assert.equal(billingAmounts(unbilled, Currency.USD, false).invoiceTotal, null);
});
