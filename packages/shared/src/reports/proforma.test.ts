/**
 * Formato del numero de proforma.
 *
 * Es una funcion de una linea, pero es la que imprime el documento, la que
 * muestra el reporte y la que el cliente dicta por telefono: si un dia le
 * apareciera un prefijo o unos ceros delante, el mismo cobro pasaria a existir
 * con dos escrituras y nadie podria buscar la suya. Lo que se protege es eso, no
 * la aritmetica.
 *
 * Runner: node:test. Correr con `pnpm --filter @courier/shared test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatShipmentCode } from '../shipments/shipment';
import { formatProformaNumber } from './proforma';

test('la primera proforma de la serie es la 1000', () => {
  // La secuencia arranca en 1000, igual que la del tramite y la del casillero.
  assert.equal(formatProformaNumber(1000), '1000');
});

test('es el consecutivo pelado: sin prefijo y sin ceros delante', () => {
  assert.equal(formatProformaNumber(1), '1');
  assert.equal(formatProformaNumber(951), '951');
  assert.equal(formatProformaNumber(123456789), '123456789');
});

test('acepta la secuencia como cadena, que es como la entrega el driver', () => {
  // `nextval` devuelve un bigint y el driver lo da como texto: convertirlo a
  // number para volver a formatearlo solo serviria para perder digitos.
  assert.equal(formatProformaNumber('1042'), formatProformaNumber(1042));
});

test('no se puede confundir con el consecutivo del tramite', () => {
  // El del tramite lleva prefijo y ancho fijo; el de la proforma, ninguno de los
  // dos. Son numeros de cosas distintas y tienen que verse distintos.
  const sequence = 1042;
  assert.notEqual(formatProformaNumber(sequence), formatShipmentCode(sequence));
  assert.equal(formatProformaNumber(sequence), '1042');
});
