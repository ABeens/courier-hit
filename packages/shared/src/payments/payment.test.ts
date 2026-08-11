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
} from './payment';

test('un abono en validacion que cubre el saldo cierra la puerta a otro pago', () => {
  assert.equal(awaitsValidation(0, 50_000, 50_000), true);
});

test('un abono en validacion MAYOR que el saldo tambien la cierra', () => {
  assert.equal(awaitsValidation(0, 60_000, 50_000), true);
});

test('el saldo restante tras un abono confirmado cuenta, no el total facturado', () => {
  // Abonados y confirmados 30.000 de 50.000; los 20.000 en validacion cubren el resto.
  assert.equal(awaitsValidation(30_000, 20_000, 50_000), true);
});

test('un abono parcial en validacion NO bloquea: queda saldo que alguien debe pagar', () => {
  assert.equal(awaitsValidation(0, 20_000, 50_000), false);
});

test('sin abonos pendientes se puede pagar', () => {
  assert.equal(awaitsValidation(0, 0, 50_000), false);
});

test('un tramite ya cubierto por dinero confirmado no esta "en validacion"', () => {
  // Eso es `isSettled`: sin saldo que cubrir, un comprobante extra no lo clasifica.
  assert.equal(awaitsValidation(50_000, 10_000, 50_000), false);
});

test('sin factura aprobada no hay nada que bloquear', () => {
  assert.equal(awaitsValidation(0, 50_000, null), false);
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
