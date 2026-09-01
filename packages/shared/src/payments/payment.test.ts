/**
 * `awaitsValidation` decide si un tramite admite otro pago. Se prueba aparte
 * porque las tres pantallas y la guarda del servidor lo consultan, y cada caso
 * que responda mal aqui es un cliente cobrado dos veces por el mismo saldo.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Currency } from '../money/currency';
import { ShipmentType } from '../workflow/shipment-type';
import {
  BANK_ACCOUNTS,
  BankAccount,
  awaitsValidation,
  bankAccountOptionLabel,
  bankAccountsFor,
  bankAccountsForStaff,
  chargeBasisFor,
  chargeBasisIn,
  chargeCurrencyFor,
  isSettled,
  PaymentStatus,
} from './payment';

/** Base de cobro en colones: la de Transporte y Agenciamiento. */
const crc = (invoiceTotal: number | null) => chargeBasisIn(Currency.CRC, invoiceTotal);

test('un abono en validacion que cubre el saldo cierra la puerta a otro pago', () => {
  assert.equal(awaitsValidation(0, 50_000, crc(50_000)), true);
});

test('un abono en validacion MAYOR que el saldo tambien la cierra', () => {
  assert.equal(awaitsValidation(0, 60_000, crc(50_000)), true);
});

test('el saldo restante tras un abono confirmado cuenta, no el total facturado', () => {
  // Abonados y confirmados 30.000 de 50.000; los 20.000 en validacion cubren el resto.
  assert.equal(awaitsValidation(30_000, 20_000, crc(50_000)), true);
});

test('un abono parcial en validacion NO bloquea: queda saldo que alguien debe pagar', () => {
  assert.equal(awaitsValidation(0, 20_000, crc(50_000)), false);
});

test('sin abonos pendientes se puede pagar', () => {
  assert.equal(awaitsValidation(0, 0, crc(50_000)), false);
});

test('un tramite ya cubierto por dinero confirmado no esta "en validacion"', () => {
  // Eso es `isSettled`: sin saldo que cubrir, un comprobante extra no lo clasifica.
  assert.equal(awaitsValidation(50_000, 10_000, crc(50_000)), false);
});

test('sin factura aprobada no hay nada que bloquear', () => {
  assert.equal(awaitsValidation(0, 50_000, crc(null)), false);
});

// ---------------------------------------------------------------------------
// Cuentas bancarias. Un error aqui manda el dinero del cliente a una cuenta
// equivocada, asi que el catalogo se prueba tan en serio como las reglas.
// ---------------------------------------------------------------------------

test('Paqueteria solo ofrece las cuentas en dolares', () => {
  const accounts = bankAccountsFor(ShipmentType.Paqueteria);
  assert.deepEqual(accounts, [BankAccount.BacUsd, BankAccount.BcrUsd]);
  assert.ok(accounts.every((a) => BANK_ACCOUNTS[a].currency === Currency.USD));
});

test('Transporte y Agenciamiento ofrecen las cuentas de las dos monedas', () => {
  for (const type of [
    ShipmentType.Aereo,
    ShipmentType.MaritimoFCL,
    ShipmentType.MaritimoLCL,
    ShipmentType.Agenciamiento,
  ]) {
    const accounts = bankAccountsFor(type);
    assert.equal(accounts.length, 4, `${type} deberia ofrecer las cuatro cuentas`);
    assert.ok(accounts.some((a) => BANK_ACCOUNTS[a].currency === Currency.CRC));
    assert.ok(accounts.some((a) => BANK_ACCOUNTS[a].currency === Currency.USD));
  }
});

test('el staff no arrastra el filtro del cliente: puede corregir a cualquier cuenta', () => {
  // Es el caso del requerimiento: un deposito de Paqueteria que en realidad
  // entro a la cuenta de colones. Si el operario no la tuviera disponible,
  // tendria que registrar un dato que sabe falso.
  const staffAccounts = bankAccountsForStaff();
  assert.equal(staffAccounts.length, 4);
  assert.ok(staffAccounts.includes(BankAccount.BacCrc));
  assert.ok(!bankAccountsFor(ShipmentType.Paqueteria).includes(BankAccount.BacCrc));
});

test('cada banco tiene exactamente una cuenta por moneda', () => {
  const seen = new Set(
    Object.values(BANK_ACCOUNTS).map((info) => `${info.bank}|${info.currency}`),
  );
  assert.equal(seen.size, Object.keys(BANK_ACCOUNTS).length);
});

test('ningun numero ni IBAN se repite entre cuentas', () => {
  const ibans = Object.values(BANK_ACCOUNTS).map((info) => info.iban);
  assert.equal(new Set(ibans).size, ibans.length);

  const numbers = Object.values(BANK_ACCOUNTS)
    .map((info) => info.number)
    .filter((n): n is string => n !== null);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('todo IBAN es costarricense y tiene los 22 caracteres del formato', () => {
  for (const info of Object.values(BANK_ACCOUNTS)) {
    assert.match(info.iban, /^CR\d{20}$/, `IBAN invalido: ${info.iban}`);
  }
});

test('la opcion del select trae el numero con el que el cliente va a depositar', () => {
  // Es el hueco que abrio el ticket: el select mostraba solo el nombre del banco.
  assert.ok(bankAccountOptionLabel(BankAccount.BacUsd).includes('954526463'));
  // BCR solo se opera por IBAN, asi que la opcion cae a el en vez de quedar coja.
  assert.ok(bankAccountOptionLabel(BankAccount.BcrUsd).includes('CR96015201001050225764'));
});

// ---------------------------------------------------------------------------
// Moneda de cobro. Es la que decide el importe que se le manda a la pasarela y
// contra la que se cancela la deuda: un error aqui cobra la cifra equivocada.
// ---------------------------------------------------------------------------

test('la Paqueteria se cobra en dolares', () => {
  assert.equal(chargeCurrencyFor(ShipmentType.Paqueteria), Currency.USD);
});

test('Transporte y Agenciamiento se cobran en colones', () => {
  for (const type of [
    ShipmentType.Aereo,
    ShipmentType.MaritimoFCL,
    ShipmentType.MaritimoLCL,
    ShipmentType.Agenciamiento,
  ]) {
    assert.equal(chargeCurrencyFor(type), Currency.CRC, `${type} deberia cobrarse en colones`);
  }
});

test('las cuentas que se ofrecen son las de la moneda en que se cobra', () => {
  // Las dos reglas salen del mismo tipo de tramite y tienen que coincidir: una
  // factura en dolares con una cuenta en colones al lado es un deposito por un
  // monto que no cuadra con nada.
  const currency = chargeCurrencyFor(ShipmentType.Paqueteria);
  for (const account of bankAccountsFor(ShipmentType.Paqueteria)) {
    assert.equal(BANK_ACCOUNTS[account].currency, currency);
  }
});

test('la base de cobro toma el total de SU moneda, no el otro', () => {
  const invoice = { invoiceTotalUsd: 50, invoiceTotalCrc: 25_500 };

  assert.deepEqual(chargeBasisFor(ShipmentType.Paqueteria, invoice), {
    currency: Currency.USD,
    invoiceTotal: 50,
  });
  assert.deepEqual(chargeBasisFor(ShipmentType.Aereo, invoice), {
    currency: Currency.CRC,
    invoiceTotal: 25_500,
  });
});

// ---------------------------------------------------------------------------
// Liquidacion en la moneda de cobro. Este es el caso que obliga a que `isSettled`
// reciba la base entera y no un total suelto.
// ---------------------------------------------------------------------------

test('un tramite en dolares se salda con los dolares que se le cobraron', () => {
  // Dos abonos que suman EXACTAMENTE la factura en dolares, congelados con tasas
  // distintas porque se pagaron en dias distintos (regla M5).
  const payments = [
    { amount: 20, currency: Currency.USD, exchangeRate: 510, status: PaymentStatus.Confirmado },
    { amount: 30, currency: Currency.USD, exchangeRate: 505, status: PaymentStatus.Confirmado },
  ];
  const invoice = { invoiceTotalUsd: 50, invoiceTotalCrc: 25_500 };

  assert.equal(isSettled(payments, chargeBasisFor(ShipmentType.Paqueteria, invoice)), true);

  // Y la razon de que no se pueda liquidar por la otra columna: reexpresados a
  // colones con SUS tasas suman 25.350 contra una factura congelada de 25.500.
  // El cliente pago los $50 que se le cobraron y el paquete se quedaria retenido
  // por 150 colones que nadie le pidio.
  assert.equal(isSettled(payments, chargeBasisIn(Currency.CRC, 25_500)), false);
});

test('un tramite en colones sigue saldandose en colones', () => {
  const payments = [
    { amount: 50_000, currency: Currency.CRC, exchangeRate: 510, status: PaymentStatus.Confirmado },
  ];
  const invoice = { invoiceTotalUsd: 98.04, invoiceTotalCrc: 50_000 };

  assert.equal(isSettled(payments, chargeBasisFor(ShipmentType.Aereo, invoice)), true);
});

test('un abono en la moneda que no es tambien cancela, convertido con su tasa', () => {
  // El staff registra a que moneda entro el deposito de verdad
  // (`bankAccountsForStaff`), asi que un tramite en dolares puede quedar cubierto
  // por un deposito en colones. Lo convierte `settledAmount` con la tasa
  // congelada del abono, no con la de hoy.
  const payments = [
    { amount: 25_500, currency: Currency.CRC, exchangeRate: 510, status: PaymentStatus.Confirmado },
  ];

  assert.equal(isSettled(payments, chargeBasisIn(Currency.USD, 50)), true);
});
