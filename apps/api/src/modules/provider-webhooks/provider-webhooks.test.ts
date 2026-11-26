/**
 * Lectura de los avisos de Helga y llaves. Runner: node:test.
 * Correr con `pnpm --filter @courier/api test`.
 *
 * Los ejemplos son los de la especificacion v1.0 (§5.1 y §6.1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  packageEnvelopeSchema,
  readPackage,
  readTracking,
  trackingEnvelopeSchema,
} from './provider-webhooks.mapping';
import { readWebhookKey } from './provider-webhooks.keys';

const PACKAGE_EXAMPLE = {
  code: 'LMX000123456',
  operation_datetime: '2026-11-04 10:15:30',
  shipper: { code: 'SJO604541', company_name: 'Juan', contact_name: 'Juan', address: null, email: null },
  consignee: { company_name: 'María', contact_name: 'María' },
  commodities: [
    {
      description: 'Ropa y accesorios',
      length_received: '30.00',
      height_received: '20.00',
      width_received: '15.00',
      weight_received: '4.50',
      weight_kg_received: '2.04',
      quantity_received: 1,
      declared_value: 120.5,
      package_notes: '1Z999AA10123456784',
    },
  ],
  attachments: { package_images: [] },
  zebra_label: { file_name: 'LMX000123456.pdf', file_type: 'application/pdf', download_url: 'https://x' },
};

test('creación: toma kg, cm, tracking y valor declarado del ejemplo', () => {
  assert.deepEqual(readPackage(PACKAGE_EXAMPLE), {
    hawb: 'LMX000123456',
    shipperCode: 'SJO604541',
    subLocker: null,
    carrierTracking: '1Z999AA10123456784',
    description: 'Ropa y accesorios',
    weightKg: 2.04,
    lengthCm: 30,
    widthCm: 15,
    heightCm: 20,
    declaredValueUsd: 120.5,
  });
});

test('creación: nulos y ceros no son medidas; package_notes vacío no es tracking', () => {
  const pkg = readPackage({
    code: ' LMX1 ',
    shipper: { code: 'SJO008835', sub_casillero: 'SJO608001' },
    commodities: [{ length_received: '0.00', weight_kg_received: null, package_notes: '  ', declared_value: null }],
  });
  assert.equal(pkg.hawb, 'LMX1');
  assert.equal(pkg.subLocker, 'SJO608001');
  assert.equal(pkg.carrierTracking, null);
  assert.equal(pkg.lengthCm, null);
  assert.equal(pkg.weightKg, null);
});

test('creación: sin code es ilegible', () => {
  assert.equal(packageEnvelopeSchema.safeParse({ commodities: [] }).success, false);
  assert.equal(packageEnvelopeSchema.safeParse({ code: '   ' }).success, false);
});

test('tracking: ejemplo de la especificación', () => {
  assert.deepEqual(
    readTracking({
      evento_id: 4587123,
      paquete: { hawb: 'LMX000123456' },
      estado_de_guia: { descripcion: 'RECIBIDO EN BODEGA MIAMI' },
      fecha_hora: '2026-11-04 14:32:10',
    }),
    { eventId: '4587123', hawb: 'LMX000123456', providerState: 'RECIBIDO EN BODEGA MIAMI' },
  );
});

test('tracking: evento_id como texto numérico se acepta; sin estado es ilegible', () => {
  assert.equal(
    trackingEnvelopeSchema.safeParse({ evento_id: '77', paquete: { hawb: 'A' }, estado_de_guia: { descripcion: 'X' } }).success,
    true,
  );
  assert.equal(
    trackingEnvelopeSchema.safeParse({ evento_id: 1, paquete: { hawb: 'A' }, estado_de_guia: {} }).success,
    false,
  );
});

test('llave: Bearer y X-API-Key; otro esquema no cuenta', () => {
  const h = (map: Record<string, string>) => (name: string) => map[name.toLowerCase()];
  assert.equal(readWebhookKey(h({ authorization: 'Bearer abc' })), 'abc');
  assert.equal(readWebhookKey(h({ 'x-api-key': 'k1', authorization: 'Bearer abc' })), 'k1');
  assert.equal(readWebhookKey(h({ authorization: 'Basic abc' })), null);
  assert.equal(readWebhookKey(h({})), null);
});
