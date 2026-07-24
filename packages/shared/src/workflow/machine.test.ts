/**
 * Reglas de editabilidad por estado (`Step.editable` + `editableFieldsAt`).
 *
 * Cubre las DOS fronteras del dominio que ordenan las ventanas de edicion:
 *   1. Identidad fisica: el tracking/AWB se congela al salir de la prealerta.
 *   2. Congelamiento de factura: al aprobar costos, los estados de bodega/entrega
 *      ya no admiten cambios de datos.
 *
 * Runner: node:test (integrado). Correr con `pnpm --filter @courier/shared test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Flow } from './shipment-type';
import { State } from './states';
import { ShipmentField } from '../shipments/shipment';
import { canEditField, editableFieldsAt, statesOf } from './machine';

/** Campos exclusivos de cada familia de tramite (coherencia tipo <-> campo). */
const PACKAGE_ONLY = [ShipmentField.Store, ShipmentField.Carrier, ShipmentField.Hawb, ShipmentField.WeightKg];
const TRANSPORT_ONLY = [ShipmentField.Warehouse, ShipmentField.Dua, ShipmentField.BillingNotes];

/** Estados de bodega/entrega: tras el congelamiento de factura no se editan datos. */
const FROZEN_PACKAGE = [
  State.EnBodegaPendientePago,
  State.EnRutaEntrega,
  State.Entregado,
  State.DevueltoBodega,
];

const set = (fields: readonly ShipmentField[]) => new Set(fields);

test('Paqueteria: Prealertado admite el tracking y todos los campos de paquete', () => {
  const f = set(editableFieldsAt(Flow.Paqueteria, State.Prealertado));
  assert.ok(f.has(ShipmentField.Tracking));
  for (const field of PACKAGE_ONLY) assert.ok(f.has(field), `falta ${field}`);
});

test('Paqueteria: al recibir en bodega el tracking queda congelado', () => {
  const f = set(editableFieldsAt(Flow.Paqueteria, State.RecibidoBodegaMiami));
  assert.ok(!f.has(ShipmentField.Tracking), 'el tracking no debe ser editable tras recibir');
  assert.ok(f.has(ShipmentField.WeightKg), 'el peso se captura al recibir: debe ser editable');
});

test('Paqueteria: en transito solo descriptivos y peso (tienda/transportista ya historicos)', () => {
  for (const state of [State.PreparandoEnvio, State.EnTransitoCostaRica, State.EnAduanas]) {
    const f = set(editableFieldsAt(Flow.Paqueteria, state));
    assert.deepEqual(
      f,
      set([ShipmentField.Description, ShipmentField.Hawb, ShipmentField.WeightKg]),
      `ventana inesperada en ${state}`,
    );
  }
});

test('Paqueteria: en facturacion el peso sigue editable (ultimo tramo antes de aprobar costos)', () => {
  const f = set(editableFieldsAt(Flow.Paqueteria, State.FacturacionEnProceso));
  assert.ok(f.has(ShipmentField.WeightKg));
  assert.ok(f.has(ShipmentField.Description));
  assert.ok(!f.has(ShipmentField.Tracking));
});

test('Estados de bodega/entrega no admiten NINGUN cambio de datos', () => {
  for (const state of FROZEN_PACKAGE) {
    assert.equal(editableFieldsAt(Flow.Paqueteria, state).length, 0, `${state} deberia estar congelado`);
  }
});

test('Invariante: el tracking solo es editable en Prealertado, en TODOS los flows', () => {
  for (const flow of Object.values(Flow)) {
    for (const state of statesOf(flow)) {
      const editable = canEditField(flow, state, ShipmentField.Tracking);
      assert.equal(
        editable,
        state === State.Prealertado,
        `tracking editable=${editable} en ${flow}/${state}, se esperaba solo en Prealertado`,
      );
    }
  }
});

test('Invariante: el peso nunca es editable en los estados congelados (post-factura)', () => {
  for (const state of FROZEN_PACKAGE) {
    assert.ok(!canEditField(Flow.Paqueteria, state, ShipmentField.WeightKg), `peso editable en ${state}`);
  }
});

test('Invariante: cada flow solo expone campos de su familia (coherencia tipo <-> campo)', () => {
  for (const state of statesOf(Flow.Paqueteria)) {
    const f = set(editableFieldsAt(Flow.Paqueteria, state));
    for (const field of TRANSPORT_ONLY) assert.ok(!f.has(field), `Paqueteria/${state} expone ${field}`);
  }
  for (const flow of [Flow.Transporte, Flow.Agenciamiento]) {
    for (const state of statesOf(flow)) {
      const f = set(editableFieldsAt(flow, state));
      for (const field of PACKAGE_ONLY) assert.ok(!f.has(field), `${flow}/${state} expone ${field}`);
    }
  }
});

test('canEditField es consistente con editableFieldsAt', () => {
  for (const flow of Object.values(Flow)) {
    for (const state of statesOf(flow)) {
      const editable = set(editableFieldsAt(flow, state));
      for (const field of Object.values(ShipmentField)) {
        assert.equal(canEditField(flow, state, field), editable.has(field), `${flow}/${state}/${field}`);
      }
    }
  }
});

test('editableFieldsAt es vacio para un estado ajeno al flow', () => {
  // ProcesoAduanas no pertenece a Paqueteria; RecibidoBodegaMiami no pertenece a Transporte.
  assert.equal(editableFieldsAt(Flow.Paqueteria, State.ProcesoAduanas).length, 0);
  assert.equal(editableFieldsAt(Flow.Transporte, State.RecibidoBodegaMiami).length, 0);
});
