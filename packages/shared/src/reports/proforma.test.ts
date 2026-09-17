/**
 * Formato del numero de proforma.
 *
 * Es una funcion de una linea, pero es la que imprime el documento, la que
 * guarda el reporte y la que el cliente dicta por telefono: si el ancho o el
 * prefijo cambian sin querer, el mismo cobro pasa a existir con dos escrituras y
 * nadie puede buscar la suya. Lo que se protege es eso, no la aritmetica.
 *
 * Runner: node:test. Correr con `pnpm --filter @courier/shared test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatShipmentCode } from '../shipments/shipment';
import { PROFORMA_CODE_PREFIX, formatProformaNumber } from './proforma';

test('la primera proforma de la serie es HSP000001000', () => {
  // La secuencia arranca en 1000, igual que la del tramite y la del casillero.
  assert.equal(formatProformaNumber(1000), 'HSP000001000');
});

test('rellena a 9 digitos y no se queda corta al crecer la serie', () => {
  assert.equal(formatProformaNumber(1), 'HSP000000001');
  assert.equal(formatProformaNumber(123456789), 'HSP123456789');
});

test('acepta la secuencia como cadena, que es como la entrega el driver', () => {
  // `nextval` devuelve un bigint y el driver lo da como texto: convertirlo a
  // number para volver a formatearlo solo serviria para perder digitos.
  assert.equal(formatProformaNumber('1042'), formatProformaNumber(1042));
});

test('no se confunde con el consecutivo del tramite: mismo ancho, otro prefijo', () => {
  const sequence = 1042;
  const proforma = formatProformaNumber(sequence);
  const shipment = formatShipmentCode(sequence);

  assert.notEqual(proforma, shipment);
  assert.equal(proforma.length, shipment.length);
  assert.ok(proforma.startsWith(PROFORMA_CODE_PREFIX));
});
