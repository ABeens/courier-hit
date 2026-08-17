/**
 * Piezas compartidas por los seeds (`seed-demo.ts` y `seed-bulk.ts`).
 *
 * Aqui vive lo que los dos necesitan igual: el catalogo de servicios de costo,
 * los helpers que traducen el dominio a filas (ubicacion, historial de estados)
 * y las utilidades de escritura por lotes. No siembra nada por si mismo: es un
 * modulo de piezas, sin efectos al importarlo.
 *
 * La regla de reparto es simple: si los dos seeds tienen que decir lo MISMO
 * (que la tasa inicial es 512,75, que "Impuesto de aduana" es un servicio de
 * agenciamiento con COD SIS FE 44), va aqui; si es una decision de ESE seed
 * (a quien se le siembra, cuantos tramites, con que nombres), se queda alla.
 */
import { sql } from 'drizzle-orm';
import type { InferInsertModel } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  CostCategory,
  Currency,
  Flow,
  ServiceKind,
  ServiceValueType,
  State,
  canTransition,
  isValidLocation,
  statesOf,
} from '@courier/shared';
import type { Db } from './core/db';

/**
 * Conexion dentro de una transaccion. Los seeds corren enteros dentro de una:
 * si algo falla a mitad, la base queda como estaba y no en un limbo a medio
 * sembrar que confunda al proximo intento.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Tasa que fija un seed si el sistema no tiene ninguna (colones por 1 USD). Es
 * la que se congela en TODO el dinero sembrado: en produccion la tasa es un
 * valor unico que fija quien tiene `exchange_rate.write`, asi que sembrar una
 * distinta por tramite mostraria un sistema que no existe. Si ya habia una tasa
 * vigente, manda esa y este valor no se usa.
 */
export const DEFAULT_EXCHANGE_RATE = 512.75;

/**
 * Tarifa de transporte internacional, en USD por libra. Es la del mapeo de
 * campos validado con el negocio ("x 3.66"), para que el reporte FULL de
 * Paqueteria de las mismas cifras que la hoja con la que se cuadra.
 */
export const DEFAULT_FREIGHT_RATE = 3.66;

export interface CostServiceSpec {
  name: string;
  kind: ServiceKind;
  /** De quien es el dinero: decide si el concepto es costo o margen en el reporte. */
  category: CostCategory;
  /** COD SIS FE del concepto; lo imprime la proforma. */
  electronicInvoiceCode: string;
  valueType: ServiceValueType;
  defaultValue: number | null;
  /** Solo cuando valueType = Fixed (es dinero). Regla M2. */
  currency: Currency | null;
  enabled?: boolean;
}

/**
 * Catalogo de servicios de costo. Transporte y agenciamiento solo admite valor
 * Manual (`allowedValueTypes`); Paqueteria admite los tres y solo USD (M6).
 *
 * `category` separa lo que HS Global solo TRASLADA (impuestos, almacen fiscal,
 * naviera) de lo que son honorarios propios. Sin ese corte, COSTOS ASOCIADOS del
 * reporte de Agenciamiento sumaria la factura entera y el PROFIT saldria en cero
 * en todas las filas sembradas. `electronicInvoiceCode` es el COD SIS FE que
 * imprime la proforma.
 *
 * Lo siembra el seed de demo; el masivo lo reutiliza tal cual (y solo lo crea si
 * la tabla estaba vacia). El catalogo es CONFIGURACION, no volumen: por eso un
 * solo dueño lo borra (`db:seed:demo -- --reset`) y el masivo nunca lo toca.
 */
export const COST_SERVICES: readonly CostServiceSpec[] = [
  { name: 'Impuesto de aduana', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Impuestos, electronicInvoiceCode: '44', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Almacenaje fiscal', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Otros, electronicInvoiceCode: '61', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Transporte terrestre', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Otros, electronicInvoiceCode: '25', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Honorarios de agenciamiento', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Propio, electronicInvoiceCode: '10', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Inspección Dekra', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Otros, electronicInvoiceCode: '73', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Desalmacenaje', kind: ServiceKind.TransporteAgenciamiento, category: CostCategory.Propio, electronicInvoiceCode: '11', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Permisos de Importación', kind: ServiceKind.Paqueteria, category: CostCategory.Otros, electronicInvoiceCode: '97', valueType: ServiceValueType.Percentage, defaultValue: 10, currency: null },
  { name: 'Seguro de mercancía', kind: ServiceKind.Paqueteria, category: CostCategory.Otros, electronicInvoiceCode: '52', valueType: ServiceValueType.Percentage, defaultValue: 2.5, currency: null },
  { name: 'Manejo en bodega Miami', kind: ServiceKind.Paqueteria, category: CostCategory.Propio, electronicInvoiceCode: '31', valueType: ServiceValueType.Fixed, defaultValue: 3.5, currency: Currency.USD },
  { name: 'Empaque especial', kind: ServiceKind.Paqueteria, category: CostCategory.Propio, electronicInvoiceCode: '32', valueType: ServiceValueType.Fixed, defaultValue: 7, currency: Currency.USD },
  { name: 'Asesoría de compra por Internet', kind: ServiceKind.Paqueteria, category: CostCategory.Propio, electronicInvoiceCode: '33', valueType: ServiceValueType.Manual, defaultValue: null, currency: null },
  { name: 'Sobrecargo de combustible', kind: ServiceKind.Paqueteria, category: CostCategory.Otros, electronicInvoiceCode: '26', valueType: ServiceValueType.Fixed, defaultValue: 1.75, currency: Currency.USD, enabled: false },
];

// ---------------------------------------------------------------------------
// Helpers de dominio
// ---------------------------------------------------------------------------

/** Provincia y canton salen del codigo del distrito (1 + 3 + 5 digitos). */
export function locationOf(districtCode: string): {
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
} {
  const provinceCode = districtCode.slice(0, 1);
  const cantonCode = districtCode.slice(0, 3);
  if (!isValidLocation(provinceCode, cantonCode, districtCode)) {
    throw new Error(`[seed] Distrito inválido en los datos sembrados: ${districtCode}`);
  }
  return { provinceCode, cantonCode, districtCode };
}

/** Valida el historial contra la maquina de estados; aborta si es imposible. */
export function assertPath(flow: Flow, path: readonly State[]): void {
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1]!;
    const to = path[i]!;
    if (!canTransition(flow, from, to)) {
      throw new Error(`[seed] Transición inválida en ${flow}: ${from} -> ${to}`);
    }
  }
}

/**
 * Historial hasta un estado: la ruta principal del flow recortada. `Devuelto a
 * bodega` no esta en la linea (es una arista extra desde En ruta de entrega),
 * asi que se arma aparte.
 */
export function pathTo(flow: Flow, target: State): State[] {
  const states = statesOf(flow);
  const path =
    target === State.DevueltoBodega
      ? [...states.slice(0, states.indexOf(State.EnRutaEntrega) + 1), State.DevueltoBodega]
      : states.slice(0, states.indexOf(target) + 1);
  assertPath(flow, path);
  return path;
}

/**
 * Dolares que cubren una deuda en colones sin quedarse corto, redondeando al
 * centimo HACIA ARRIBA.
 *
 * Deliberadamente NO usa `convertMoney`/`roundMoney`: esos redondean al mas
 * cercano, y medio centimo hacia abajo deja la factura sin cubrir por una
 * fraccion. `isSettled` compara lo abonado contra el total con `>=`, asi que ese
 * centimo es la diferencia entre un tramite que puede salir a ruta y uno que no.
 * Es el mismo criterio que el cobro real: al cliente se le cobra el importe que
 * salda la deuda, nunca uno que la deja abierta por redondeo.
 *
 * Vive aqui, y no repetida en cada seed, para que los dos cobren igual.
 */
export function usdToCoverCrc(crc: number, exchangeRate: number): number {
  return Math.ceil((crc / exchangeRate) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Escritura por lotes
// ---------------------------------------------------------------------------

/**
 * Inserta en tandas. Un INSERT de Drizzle manda un parametro por celda y
 * Postgres no acepta mas de 65.535 en una sentencia, asi que sembrar decenas de
 * miles de filas de un solo `values(...)` no falla por lento sino por invalido.
 * El tamaño de tanda lo elige quien llama, que es quien sabe cuantas columnas
 * tiene su tabla (columnas x tanda debe quedar holgadamente bajo el limite).
 */
export async function insertChunked<T extends PgTable>(
  tx: Tx,
  table: T,
  rows: readonly InferInsertModel<T>[],
  chunkSize: number,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize) as InferInsertModel<T>[];
    if (chunk.length > 0) await tx.insert(table).values(chunk);
  }
}

/**
 * Consecutivos de negocio: se piden a la misma secuencia que usa la API, en un
 * solo viaje. `generate_series` evita N llamadas a `nextval` desde el cliente.
 */
export async function nextSequence(
  tx: Tx,
  name: 'hs_shipment_code_seq' | 'hs_client_code_seq',
  n: number,
): Promise<string[]> {
  if (n === 0) return [];
  const query =
    name === 'hs_shipment_code_seq'
      ? sql`select nextval('hs_shipment_code_seq') as val from generate_series(1, ${n})`
      : sql`select nextval('hs_client_code_seq') as val from generate_series(1, ${n})`;
  const rows = (await tx.execute(query)) as Array<{ val: string }>;
  if (rows.length !== n) throw new Error(`[seed] No se pudieron generar ${n} consecutivos.`);
  return rows.map((r) => String(r.val));
}

// ---------------------------------------------------------------------------
// Azar reproducible
// ---------------------------------------------------------------------------

/**
 * Generador pseudoaleatorio con semilla (mulberry32). Los datos masivos se
 * sortean, pero NO con `Math.random`: dos corridas con la misma semilla tienen
 * que dar exactamente la misma base. Si no, "el reporte tarda 4 s" deja de ser
 * una medicion y pasa a ser una anecdota sobre los datos que salieron ese dia.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Flotante en [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Entero en [min, max], ambos incluidos. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True con probabilidad `p` (0..1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Un elemento cualquiera de la lista (la lista no puede estar vacia). */
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)]!;
  }

  /**
   * Un indice de `weights` con probabilidad proporcional a su peso. Es lo que
   * permite que la mezcla de tipos y estados sea la de la operacion real (mucha
   * paqueteria entregada, poca carga maritima en aduanas) y no un reparto plano.
   */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let ticket = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      ticket -= weights[i]!;
      if (ticket < 0) return i;
    }
    return weights.length - 1;
  }
}
