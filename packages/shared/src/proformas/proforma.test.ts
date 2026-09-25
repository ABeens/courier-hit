/**
 * Reglas de la proforma como entidad: que tramite cabe en que proforma, que
 * flujo agrupa solo y en que moneda se emite.
 *
 * Runner: node:test. Correr con `pnpm --filter @courier/shared test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Currency } from '../money/currency';
import { Flow, ShipmentType } from '../workflow/shipment-type';
import { formatShipmentCode } from '../shipments/shipment';
import {
  ProformaDeliveryStatus,
  proformaDeliveryStatus,
  ProformaJoinBlock,
  allocateProformaInvoices,
  formatProformaNumber,
  sumInvoices,
  ProformaStatus,
  groupsAutomatically,
  isProformaEditable,
  joinBlockFor,
  proformaCurrencyFor,
} from './proforma';
import type { ProformaIdentity } from './proforma';

const CLIENT = 'cliente-a';

const packageDraft: ProformaIdentity = {
  clientId: CLIENT,
  flow: Flow.Paqueteria,
  currency: Currency.USD,
  status: ProformaStatus.Borrador,
};

const transportDraft: ProformaIdentity = {
  clientId: CLIENT,
  flow: Flow.Transporte,
  currency: Currency.CRC,
  status: ProformaStatus.Borrador,
};

test('solo el borrador se edita', () => {
  assert.equal(isProformaEditable(ProformaStatus.Borrador), true);
  assert.equal(isProformaEditable(ProformaStatus.Aprobada), false);
  assert.equal(isProformaEditable(ProformaStatus.Pagada), false);
});

test('solo Paqueteria arma sus borradores sola', () => {
  assert.equal(groupsAutomatically(Flow.Paqueteria), true);
  assert.equal(groupsAutomatically(Flow.Transporte), false);
  assert.equal(groupsAutomatically(Flow.Agenciamiento), false);
});

test('la moneda de la proforma es la de cobro del flujo', () => {
  assert.equal(proformaCurrencyFor(ShipmentType.Paqueteria), Currency.USD);
  assert.equal(proformaCurrencyFor(ShipmentType.Aereo), Currency.CRC);
  assert.equal(proformaCurrencyFor(ShipmentType.Agenciamiento), Currency.CRC);
});

test('un paquete del mismo cliente entra a su borrador de Paqueteria', () => {
  assert.equal(
    joinBlockFor(packageDraft, { clientId: CLIENT, shipmentType: ShipmentType.Paqueteria }),
    null,
  );
});

test('una proforma aprobada o pagada no recibe tramites', () => {
  for (const status of [ProformaStatus.Aprobada, ProformaStatus.Pagada]) {
    assert.equal(
      joinBlockFor(
        { ...packageDraft, status },
        { clientId: CLIENT, shipmentType: ShipmentType.Paqueteria },
      ),
      ProformaJoinBlock.NotDraft,
    );
  }
});

test('no se mezclan clientes', () => {
  assert.equal(
    joinBlockFor(packageDraft, { clientId: 'cliente-b', shipmentType: ShipmentType.Paqueteria }),
    ProformaJoinBlock.OtherClient,
  );
});

test('no se mezclan flujos: un agenciamiento no entra a una proforma de Transporte', () => {
  assert.equal(
    joinBlockFor(transportDraft, { clientId: CLIENT, shipmentType: ShipmentType.Agenciamiento }),
    ProformaJoinBlock.OtherFlow,
  );
});

test('dentro de Transporte se juntan aereo y maritimo', () => {
  for (const shipmentType of [ShipmentType.Aereo, ShipmentType.MaritimoFCL, ShipmentType.MaritimoLCL]) {
    assert.equal(joinBlockFor(transportDraft, { clientId: CLIENT, shipmentType }), null);
  }
});

test('monedas distintas, proformas distintas', () => {
  // Un borrador de Transporte en dolares (dato imposible hoy) no recibe tramites
  // que se cobran en colones: la moneda se revisa aunque hoy la fije el flujo.
  assert.equal(
    joinBlockFor(
      { ...transportDraft, currency: Currency.USD },
      { clientId: CLIENT, shipmentType: ShipmentType.Aereo },
    ),
    ProformaJoinBlock.OtherCurrency,
  );
});

test('el numero es el consecutivo pelado: sin prefijo y sin ceros delante', () => {
  assert.equal(formatProformaNumber(1), '1');
  assert.equal(formatProformaNumber(951), '951');
  assert.equal(formatProformaNumber('1042'), '1042');
});

test('el numero de proforma no se puede confundir con el consecutivo del tramite', () => {
  assert.notEqual(formatProformaNumber(1042), formatShipmentCode(1042));
});

test('los servicios de la proforma se reparten sin perder ni inventar un centimo', () => {
  const own = [
    { usd: 21.6, crc: 9708.77 },
    { usd: 10.8, crc: 4854.38 },
    { usd: 5.4, crc: 2427.19 },
  ];
  const extras = { usd: 10, crc: 4494.8 };
  const invoices = allocateProformaInvoices(own, extras, Currency.USD);
  const total = sumInvoices(invoices);
  assert.equal(total.usd, sumInvoices([...own, extras]).usd);
  assert.equal(total.crc, sumInvoices([...own, extras]).crc);
  // El que mas cobra se lleva la mayor parte.
  assert.ok(invoices[0]!.usd - own[0]!.usd > invoices[2]!.usd - own[2]!.usd);
});

test('sin servicios de la proforma la factura de cada tramite es la suya', () => {
  const own = [{ usd: 12.34, crc: 5555 }];
  assert.deepEqual(allocateProformaInvoices(own, { usd: 0, crc: 0 }, Currency.USD), own);
});

test('en una proforma en colones se reparte por lo que cobra cada tramite en colones', () => {
  const own = [
    { usd: 100, crc: 50000 },
    { usd: 100, crc: 150000 },
  ];
  const invoices = allocateProformaInvoices(own, { usd: 8, crc: 4000 }, Currency.CRC);
  assert.equal(invoices[0]!.crc, 51000);
  assert.equal(invoices[1]!.crc, 153000);
});

test('Paqueteria: entregada, parcial o pendiente segun sus paquetes', () => {
  assert.equal(proformaDeliveryStatus(Flow.Paqueteria, { total: 3, delivered: 3, finished: 0 }), ProformaDeliveryStatus.Entregada);
  assert.equal(proformaDeliveryStatus(Flow.Paqueteria, { total: 3, delivered: 1, finished: 0 }), ProformaDeliveryStatus.EntregadaParcial);
  assert.equal(proformaDeliveryStatus(Flow.Paqueteria, { total: 3, delivered: 0, finished: 0 }), ProformaDeliveryStatus.Pendiente);
});

test('Transporte y Agenciamiento se cierran en Tramite finalizado, sin entrega aparte', () => {
  assert.equal(proformaDeliveryStatus(Flow.Transporte, { total: 2, delivered: 0, finished: 2 }), ProformaDeliveryStatus.Cerrada);
  assert.equal(proformaDeliveryStatus(Flow.Agenciamiento, { total: 2, delivered: 0, finished: 1 }), ProformaDeliveryStatus.Pendiente);
});
