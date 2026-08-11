/**
 * Columnas CALCULADAS de los reportes por servicio.
 *
 * Se prueba aqui y no en la API porque son formulas del negocio, no consultas: lo
 * que hay que proteger es que un margen negativo salga negativo, que un dato
 * faltante no se disfrace de cero y que el mes de cierre no se corra por la zona
 * horaria. Nada de eso depende de la BD.
 *
 * Runner: node:test. Correr con `pnpm --filter @courier/shared test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Currency } from '../money/currency';
import { CostCategory } from '../costs/cost-service';
import { CostLineSource, breakdownByCategory, categoryForLine } from '../costs/shipment-cost';
import {
  depositDifference,
  grossProfitUsd,
  internationalFreightUsd,
  marginPercentage,
  monthOf,
  totalCostUsd,
} from './financials';

/** Linea de costo minima, en dolares y con tasa 1:1 salvo que se indique otra. */
const line = (amount: number, category: CostCategory, currency = Currency.USD, rate = 500) => ({
  amount,
  currency,
  exchangeRate: rate,
  category,
});

// ---------------------------------------------------------------------------
// TRANSPORTE INTL (campo 21)
// ---------------------------------------------------------------------------

test('el transporte internacional usa el factor del documento: kg × 2.204 × tarifa', () => {
  // 2 kg = 4.408 lb; 4.408 × 3.66 = 16.13328 -> 16.13
  assert.equal(internationalFreightUsd(2, 3.66), 16.13);
});

test('sin peso o sin tarifa el transporte internacional es null, NO cero', () => {
  // Un cero diria que traer el paquete no costo nada y se sumaria al total.
  assert.equal(internationalFreightUsd(null, 3.66), null);
  assert.equal(internationalFreightUsd(2, null), null);
});

// ---------------------------------------------------------------------------
// TOTAL de costos (campo 24) y GROSS PROFIT (campo 25)
// ---------------------------------------------------------------------------

test('el TOTAL suma los tres costos', () => {
  assert.equal(totalCostUsd(16.13, 2.23, 1.5), 19.86);
});

test('sin transporte internacional el TOTAL es null: un total incompleto infla el margen', () => {
  assert.equal(totalCostUsd(null, 2.23, 1.5), null);
});

test('el GROSS PROFIT puede ser NEGATIVO (vender por debajo del costo se tiene que ver)', () => {
  // El propio ejemplo de proforma da negativo: se cobra 17.13 y cuesta 18.36.
  assert.equal(grossProfitUsd(17.13, 18.36), -1.23);
});

test('sin factura aprobada o sin costo completo no hay profit que reportar', () => {
  assert.equal(grossProfitUsd(null, 19.86), null);
  assert.equal(grossProfitUsd(100, null), null);
});

// ---------------------------------------------------------------------------
// % de margen (campo 26)
// ---------------------------------------------------------------------------

test('el margen se expresa en PORCENTAJE, no en fraccion', () => {
  assert.equal(marginPercentage(25, 100), 25);
  assert.equal(marginPercentage(1, 3), 33.33);
});

test('una factura en cero no tiene margen expresable (no da Infinity)', () => {
  assert.equal(marginPercentage(10, 0), null);
  assert.equal(marginPercentage(10, null), null);
});

// ---------------------------------------------------------------------------
// DIF del deposito (campo 18 de Agenciamiento)
// ---------------------------------------------------------------------------

test('el DIF NO se acota a cero: un sobrepago sale negativo porque es la anomalia a ver', () => {
  assert.equal(depositDifference(100, 120, Currency.USD), -20);
  assert.equal(depositDifference(100, 80, Currency.USD), 20);
});

// ---------------------------------------------------------------------------
// Desglose por categoria: el corte que hace que el PROFIT no salga en cero
// ---------------------------------------------------------------------------

test('COSTOS ASOCIADOS deja fuera el flete y los honorarios propios', () => {
  const lines = [
    line(420, CostCategory.Impuestos),
    line(85, CostCategory.Otros),
    line(150, CostCategory.Propio),
  ];
  const breakdown = breakdownByCategory(lines, Currency.USD);

  assert.equal(breakdown.impuestos, 420);
  assert.equal(breakdown.otros, 85);
  assert.equal(breakdown.propio, 150);
  // Lo que de verdad cuesta el tramite: impuestos + otros. Los honorarios no.
  assert.equal(breakdown.passThrough, 505);
});

test('el PROFIT de Agenciamiento es lo que se factura menos lo trasladado', () => {
  const lines = [
    line(420, CostCategory.Impuestos),
    line(85, CostCategory.Otros),
    line(150, CostCategory.Propio),
  ];
  const { passThrough } = breakdownByCategory(lines, Currency.USD);
  const invoiced = 655; // la suma de las tres lineas

  // Sin la clasificacion, COSTOS ASOCIADOS seria 655 y el PROFIT exactamente 0.
  assert.equal(grossProfitUsd(invoiced, passThrough), 150);
  assert.equal(marginPercentage(150, invoiced), 22.9);
});

test('cada linea se convierte con SU propia tasa, no con una global', () => {
  const lines = [
    line(500, CostCategory.Impuestos, Currency.CRC, 500), // = 1 USD
    line(600, CostCategory.Impuestos, Currency.CRC, 600), // = 1 USD
  ];
  assert.equal(breakdownByCategory(lines, Currency.USD).impuestos, 2);
});

test('el flete queda fuera de los costos: es cobro al cliente, no gasto', () => {
  const lines = [line(14.9, CostCategory.Flete), line(2.23, CostCategory.Impuestos)];
  const breakdown = breakdownByCategory(lines, Currency.USD);

  assert.equal(breakdown.flete, 14.9);
  assert.equal(breakdown.passThrough, 2.23, 'el flete no puede contarse como costo');
});

test('la linea de flete recibe su categoria del sistema, no del catalogo', () => {
  // Aunque el servicio dijera otra cosa, una linea Freight es Flete.
  assert.equal(categoryForLine(CostLineSource.Freight, CostCategory.Impuestos), CostCategory.Flete);
  // Una linea sin servicio de catalogo cae en el supuesto conservador.
  assert.equal(categoryForLine(CostLineSource.Service, null), CostCategory.Otros);
  assert.equal(categoryForLine(CostLineSource.Service, CostCategory.Propio), CostCategory.Propio);
});

// ---------------------------------------------------------------------------
// MES (campos 13 / 10)
// ---------------------------------------------------------------------------

test('el MES se calcula en hora de Costa Rica, no en UTC', () => {
  // 30 de junio 20:00 en Costa Rica es el 1 de julio en UTC: contarlo en julio
  // descuadraria el cierre del mes.
  assert.equal(monthOf('2026-07-01T02:00:00Z'), '2026-06');
  assert.equal(monthOf('2026-07-01T06:00:00Z'), '2026-07');
});

test('el MES sale como YYYY-MM para poder agrupar y ordenar', () => {
  assert.equal(monthOf('2026-04-15T12:00:00Z'), '2026-04');
});

test('sin fecha no hay mes', () => {
  assert.equal(monthOf(null), null);
  assert.equal(monthOf('no es una fecha'), null);
});
