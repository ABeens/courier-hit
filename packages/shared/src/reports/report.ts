/**
 * Catalogo de reportes (docs/manuales/roles.md §2, filas "Reportes").
 *
 * La matriz de roles distingue TRES niveles de reporte y ese corte es lo que
 * define el modulo: no son cuatro consultas sueltas, son cuatro vistas con
 * distinto grado de exposicion. La decision de Discovery detras es explicita —
 * "no exponer información clasificada al personal no administrador" (Minuta 2,
 * decisiones 12-13)— y se materializa en QUE COLUMNAS lleva cada uno.
 *
 * Por eso las columnas viven aqui y no en la API: el permiso no solo decide si
 * puedes pedir el reporte, decide cuanto ves de el, y esa relacion tiene que ser
 * legible de un vistazo.
 */
import { Permission } from '../auth/permissions';
import type { Role } from '../auth/roles';
import { can } from '../auth/permissions';
import { MANUAL_SHIPMENT_TYPES } from '../shipments/shipment';
import { ShipmentType } from '../workflow/shipment-type';

export enum ReportKind {
  /** Columnas limitadas: sirve para atender al cliente sin ver costos internos. */
  OperativoBasico = 'operativo_basico',
  /** Todo el detalle operativo, incluido el monto de factura. */
  OperativoCompleto = 'operativo_completo',
  /** Movimiento de estados: que paso con cada tramite y cuando. */
  Transaccional = 'transaccional',
  /** Facturacion y saldos por cliente (estado de cuenta). */
  Financiero = 'financiero',

  // --- Reportes POR SERVICIO (mapeo de campos validado con el negocio) ---
  /** Paqueteria, los 27 campos: incluye costos, margen y factura electronica. */
  PaqueteriaFull = 'paqueteria_full',
  /** Paqueteria, campos 1 al 15: hasta el monto de factura, sin costos ni margen. */
  PaqueteriaOperativo = 'paqueteria_operativo',
  /** Agenciamiento y transporte, los 23 campos. */
  AgenciamientoFull = 'agenciamiento_full',
  /** Agenciamiento y transporte, campos 1 al 18: sin costos, profit ni margen. */
  AgenciamientoOperativo = 'agenciamiento_operativo',
}

export const REPORT_LABELS: Record<ReportKind, string> = {
  [ReportKind.OperativoBasico]: 'Operativo básico',
  [ReportKind.OperativoCompleto]: 'Operativo completo',
  [ReportKind.Transaccional]: 'Transaccional',
  [ReportKind.Financiero]: 'Financiero — estado de cuenta',
  [ReportKind.PaqueteriaFull]: 'Paquetería — FULL',
  [ReportKind.PaqueteriaOperativo]: 'Paquetería — operativo',
  [ReportKind.AgenciamientoFull]: 'Agenciamiento y transporte — FULL',
  [ReportKind.AgenciamientoOperativo]: 'Agenciamiento y transporte — operativo',
};

export const REPORT_DESCRIPTIONS: Record<ReportKind, string> = {
  [ReportKind.OperativoBasico]:
    'Trámites con sus datos de seguimiento, sin montos ni costos internos.',
  [ReportKind.OperativoCompleto]:
    'Trámites con todo el detalle operativo y el monto de factura aprobado.',
  [ReportKind.Transaccional]:
    'Historial de cambios de estado de cada trámite, con quién lo movió y cuándo.',
  [ReportKind.Financiero]:
    'Facturado, abonado y saldo por cliente, con el detalle de cada trámite.',
  [ReportKind.PaqueteriaFull]:
    'Paquetes con todo: cobro, costos, transporte internacional, margen y factura electrónica.',
  [ReportKind.PaqueteriaOperativo]:
    'Paquetes con su seguimiento, entrega y monto de factura. Sin costos ni margen.',
  [ReportKind.AgenciamientoFull]:
    'Trámites con todo: cobro, depósito, costos asociados, profit y factura electrónica.',
  [ReportKind.AgenciamientoOperativo]:
    'Trámites con su seguimiento, facturación y depósito. Sin costos ni profit.',
};

/** Permiso que habilita cada reporte (docs/manuales/roles.md §2). */
export const REPORT_PERMISSIONS: Record<ReportKind, Permission> = {
  [ReportKind.OperativoBasico]: Permission.ReportsOperationalBasic,
  [ReportKind.OperativoCompleto]: Permission.ReportsOperationalFull,
  [ReportKind.Transaccional]: Permission.ReportsOperationalFull,
  [ReportKind.Financiero]: Permission.ReportsFinancial,
  [ReportKind.PaqueteriaFull]: Permission.ReportsFull,
  [ReportKind.PaqueteriaOperativo]: Permission.ReportsOperational,
  [ReportKind.AgenciamientoFull]: Permission.ReportsFull,
  [ReportKind.AgenciamientoOperativo]: Permission.ReportsOperational,
};

/**
 * Tipos de tramite que incluye cada reporte, cuando el reporte ES de un servicio.
 *
 * No es un filtro que el usuario elija: un reporte de Paqueteria con un trámite
 * aereo dentro tendria media tabla vacia (no hay tienda, ni HAWB, ni peso de
 * bascula). El acotamiento lo impone el servidor y por eso vive aqui, al lado de
 * las columnas: son la misma decision vista desde dos lados.
 *
 * Los reportes transversales (operativo basico/completo, transaccional,
 * financiero) no aparecen: los cuatro cubren todos los tipos.
 */
export const REPORT_SHIPMENT_TYPES: Partial<Record<ReportKind, readonly ShipmentType[]>> = {
  [ReportKind.PaqueteriaFull]: [ShipmentType.Paqueteria],
  [ReportKind.PaqueteriaOperativo]: [ShipmentType.Paqueteria],
  // Aereo, maritimo FCL/LCL y agenciamiento: el mapeo los trata juntos ("SERVICIO:
  // Agenciamiento, Marítimo FCL, Marítimo LCL, Aéreo") porque comparten columnas.
  [ReportKind.AgenciamientoFull]: MANUAL_SHIPMENT_TYPES,
  [ReportKind.AgenciamientoOperativo]: MANUAL_SHIPMENT_TYPES,
};

/** Reportes que un rol puede generar. Lo consumen la API y la pantalla. */
export function reportsFor(role: Role): ReportKind[] {
  return Object.values(ReportKind).filter((kind) => can(role, REPORT_PERMISSIONS[kind]));
}

/** Una columna del reporte: la clave del dato y su encabezado. */
export interface ReportColumn {
  key: string;
  label: string;
}

/**
 * PAQUETERIA, los 27 campos del mapeo, EN SU ORDEN. El orden no es cosmetico:
 * el reporte operativo se define mas abajo como el prefijo de este ("Solo puede
 * ver del Campo 1 al Campo 15"), asi que mover una columna de sitio cambia que
 * ve el personal no administrador.
 *
 * Los comentarios numerados son el puente con el documento del negocio: sin
 * ellos, cuadrar 27 columnas contra una tabla en Word se hace a ojo.
 */
const PAQUETERIA_COLUMNS: readonly ReportColumn[] = [
  { key: 'service', label: 'SERVICIO' }, //                        1  constante
  { key: 'code', label: 'Consecutivo Interno HS' }, //              2
  { key: 'clientName', label: 'CLIENTE' }, //                       3
  { key: 'tracking', label: 'TRACKING' }, //                        4
  { key: 'store', label: 'TIENDA' }, //                             5
  { key: 'carrier', label: 'CARRIER' }, //                          6
  { key: 'description', label: 'REF' }, //                          7
  { key: 'miamiArrivalAt', label: 'FECHA DE ARRIBO A MIAMI' }, //   8  derivado del historial
  { key: 'hawb', label: 'HAWB' }, //                                9
  { key: 'weightKg', label: 'WEIGHT KG' }, //                      10
  { key: 'state', label: 'ESTATUS' }, //                           11
  { key: 'deliveredAt', label: 'FECHA ENTREGA' }, //               12  derivado del historial
  { key: 'month', label: 'MES' }, //                               13  derivado de 12
  { key: 'proforma', label: 'PROFORMA' }, //                       14  = consecutivo
  { key: 'invoiceTotalUsd', label: 'MONTO FACTURA' }, //           15
  // --- A partir de aqui, solo el reporte FULL (admin) ---
  { key: 'collectionStatus', label: 'ESTATUS COBRO' }, //          16  derivado de los pagos
  { key: 'bankAccount', label: 'CUENTA' }, //                      17
  { key: 'receipt', label: 'COMPROBANTE' }, //                     18
  { key: 'paidAt', label: 'FECHA' }, //                            19  derivado del pago
  { key: 'billingNotes', label: 'NOTAS P/FACTURAR' }, //           20
  { key: 'internationalFreightUsd', label: 'TRANSPORTE INTL' }, // 21  calculado
  { key: 'taxesUsd', label: 'IMPUESTOS' }, //                      22
  { key: 'othersUsd', label: 'OTROS / COMPRAS' }, //               23
  { key: 'totalCostUsd', label: 'TOTAL' }, //                      24  = 21+22+23
  { key: 'grossProfitUsd', label: 'GROSS PROFIT' }, //             25  = 15-24
  { key: 'marginPct', label: '%' }, //                             26  = 25/15
  { key: 'electronicInvoiceNumber', label: 'FE' }, //              27
];

/** Ultimo campo que ve el reporte operativo de Paqueteria (MONTO FACTURA). */
const PAQUETERIA_OPERATIONAL_FIELDS = 15;

/**
 * AGENCIAMIENTO y transporte, los 23 campos del mapeo, en su orden. Mismo trato
 * que Paqueteria: el operativo es el prefijo (campos 1 al 18).
 */
const AGENCIAMIENTO_COLUMNS: readonly ReportColumn[] = [
  { key: 'code', label: 'Consecutivo Interno HS' }, //              1
  { key: 'shipmentType', label: 'SERVICIO' }, //                    2
  { key: 'warehouse', label: 'ALMACEN' }, //                        3
  { key: 'clientName', label: 'CLIENTE' }, //                       4
  { key: 'tracking', label: 'AWB / BL' }, //                        5
  { key: 'description', label: 'REF' }, //                          6
  { key: 'dua', label: 'DUA' }, //                                  7
  { key: 'state', label: 'ESTATUS' }, //                            8
  { key: 'invoicedAt', label: 'FECHA FACTURACIÓN' }, //             9
  { key: 'month', label: 'MES' }, //                               10  derivado de 9
  { key: 'proforma', label: 'PROFORMA' }, //                       11  = consecutivo
  { key: 'invoiceTotalUsd', label: 'MONTO FACTURA' }, //           12
  { key: 'collectionStatus', label: 'ESTATUS COBRO' }, //          13  derivado de los pagos
  { key: 'bankAccount', label: 'CUENTA' }, //                      14
  { key: 'receipt', label: 'COMPROBANTE DEPOSITO' }, //            15
  { key: 'paidAt', label: 'FECHA DEPOSITO' }, //                   16  derivado del pago
  { key: 'depositedUsd', label: 'MONTO DEPOSITADO' }, //           17  derivado de los abonos
  { key: 'differenceUsd', label: 'DIF' }, //                       18  = 12-17
  // --- A partir de aqui, solo el reporte FULL (admin) ---
  { key: 'billingNotes', label: 'NOTAS P/FACTURAR' }, //           19
  { key: 'associatedCostsUsd', label: 'COSTOS ASOCIADOS' }, //     20  lineas trasladadas
  { key: 'profitUsd', label: 'PROFIT' }, //                        21  = 12-20
  { key: 'marginPct', label: '%' }, //                             22  = 21/12
  { key: 'electronicInvoiceNumber', label: 'FE' }, //              23
];

/** Ultimo campo que ve el reporte operativo de Agenciamiento (DIF). */
const AGENCIAMIENTO_OPERATIONAL_FIELDS = 18;

/**
 * Columnas de cada reporte, en orden. El Basico es un SUBCONJUNTO estricto del
 * Completo, y esa es justamente la separacion que pide la matriz: lo que le falta
 * al basico (peso, monto de factura) es lo que no debe ver el personal no
 * administrador.
 */
export const REPORT_COLUMNS: Record<ReportKind, readonly ReportColumn[]> = {
  [ReportKind.OperativoBasico]: [
    { key: 'code', label: 'Consecutivo' },
    { key: 'shipmentType', label: 'Trámite' },
    { key: 'clientName', label: 'Cliente' },
    { key: 'tracking', label: 'Tracking / AWB / BL' },
    { key: 'description', label: 'Descripción (REF)' },
    { key: 'state', label: 'Estatus' },
    { key: 'routeNumber', label: 'Ruta' },
    { key: 'createdAt', label: 'Fecha ingreso' },
  ],

  [ReportKind.OperativoCompleto]: [
    { key: 'code', label: 'Consecutivo' },
    { key: 'shipmentType', label: 'Trámite' },
    { key: 'clientCode', label: 'Casillero' },
    { key: 'clientName', label: 'Cliente' },
    { key: 'tracking', label: 'Tracking / AWB / BL' },
    { key: 'description', label: 'Descripción (REF)' },
    { key: 'store', label: 'Tienda' },
    { key: 'carrier', label: 'Transportista' },
    { key: 'hawb', label: 'HAWB / HBL' },
    { key: 'weightKg', label: 'Peso (kg)' },
    { key: 'warehouse', label: 'Almacén' },
    { key: 'dua', label: 'DUA' },
    { key: 'state', label: 'Estatus' },
    { key: 'routeNumber', label: 'Ruta' },
    { key: 'invoiceTotalUsd', label: 'Factura (USD)' },
    { key: 'invoiceTotalCrc', label: 'Factura (CRC)' },
    { key: 'createdAt', label: 'Fecha ingreso' },
  ],

  [ReportKind.Transaccional]: [
    { key: 'code', label: 'Consecutivo' },
    { key: 'shipmentType', label: 'Trámite' },
    { key: 'clientName', label: 'Cliente' },
    { key: 'tracking', label: 'Tracking / AWB / BL' },
    { key: 'state', label: 'Estado' },
    { key: 'note', label: 'Comentario' },
    { key: 'createdByName', label: 'Registrado por' },
    { key: 'createdAt', label: 'Fecha del movimiento' },
  ],

  [ReportKind.Financiero]: [
    { key: 'clientCode', label: 'Casillero' },
    { key: 'clientName', label: 'Cliente' },
    { key: 'code', label: 'Consecutivo' },
    { key: 'description', label: 'Descripción (REF)' },
    { key: 'state', label: 'Estatus' },
    { key: 'invoiceTotalCrc', label: 'Facturado (CRC)' },
    { key: 'settledCrc', label: 'Abonado (CRC)' },
    { key: 'balanceCrc', label: 'Saldo (CRC)' },
    { key: 'createdAt', label: 'Fecha ingreso' },
  ],

  /**
   * El operativo es el PREFIJO del FULL, no una lista paralela. Se corta con
   * `slice` en vez de repetir 15 (o 18) columnas por el mismo motivo por el que
   * el Basico es subconjunto del Completo: el corte del mapeo es literalmente
   * "del campo 1 al 15", y dos listas escritas a mano acabarian divergiendo el
   * dia que alguien renombre una columna en una sola de ellas.
   */
  [ReportKind.PaqueteriaFull]: PAQUETERIA_COLUMNS,
  [ReportKind.PaqueteriaOperativo]: PAQUETERIA_COLUMNS.slice(0, PAQUETERIA_OPERATIONAL_FIELDS),
  [ReportKind.AgenciamientoFull]: AGENCIAMIENTO_COLUMNS,
  [ReportKind.AgenciamientoOperativo]: AGENCIAMIENTO_COLUMNS.slice(0, AGENCIAMIENTO_OPERATIONAL_FIELDS),
};

/** Fila de un reporte: valores ya listos para mostrar (la API los serializa). */
export type ReportRow = Record<string, string | number | null>;

/** Reporte generado: sus columnas y sus filas. */
export interface ReportDto {
  kind: ReportKind;
  columns: readonly ReportColumn[];
  rows: ReportRow[];
}
