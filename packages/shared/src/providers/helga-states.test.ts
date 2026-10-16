/**
 * Homologacion de estados de Helga, en particular las parejas `estado` +
 * `estadoAlt` (`HELGA_ALT_STATE_MAP`).
 *
 * Runner: node:test. Correr con `pnpm --filter @courier/shared test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { State } from '../workflow/states';
import { mapProviderState } from './helga-states';

test('NOVEDAD con estadoAlt EN ADUANAS avanza a En aduanas', () => {
  assert.deepEqual(mapProviderState('NOVEDAD', 'EN ADUANAS'), { kind: 'advance', state: State.EnAduanas });
});

test('la pareja no distingue mayusculas ni espacios', () => {
  assert.deepEqual(mapProviderState(' novedad ', ' en aduanas '), { kind: 'advance', state: State.EnAduanas });
});

test('NOVEDAD sin estadoAlt, o con uno no homologado, sigue siendo incidencia', () => {
  assert.deepEqual(mapProviderState('NOVEDAD'), { kind: 'incident', providerState: 'NOVEDAD' });
  assert.deepEqual(mapProviderState('NOVEDAD', 'NOVEDAD'), { kind: 'incident', providerState: 'NOVEDAD' });
  assert.deepEqual(mapProviderState('NOVEDAD', 'EN TRANSITO'), { kind: 'incident', providerState: 'NOVEDAD' });
});

test('un estadoAlt que coincide con un estado de la tabla no mueve nada por si solo', () => {
  assert.deepEqual(mapProviderState('EN ABANDONO', 'RECIBIDO'), { kind: 'incident', providerState: 'EN ABANDONO' });
});

test('Manifestada y Entregado a Aerolinea van a En transito a Costa Rica', () => {
  for (const raw of ['MANIFESTADA', 'ENTREGADA A AEROLINEA', 'Entregado a Aerolínea']) {
    assert.deepEqual(mapProviderState(raw), { kind: 'advance', state: State.EnTransitoCostaRica });
  }
});

test('En Aduana, Listo en Sucursal Escazu y Entregado a Destinatario van a En aduanas', () => {
  for (const raw of ['En Aduana', 'Listo en Sucursal Escazú', 'Entregado a Destinatario', 'ENTREGADA A DESTINATARIO']) {
    assert.deepEqual(mapProviderState(raw), { kind: 'advance', state: State.EnAduanas });
  }
});
