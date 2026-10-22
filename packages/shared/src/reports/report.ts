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
  /** Proformas emitidas, lo abonado y el saldo (estado de cuenta). */
  Financiero = 'financiero',

  // --- Reportes POR SERVICIO (mapeo de campos validado con el negocio) ---
  /** Paqueteria completo: incluye cobro, costos, gross profit y margen. */
  PaqueteriaFull = 'paqueteria_full',
  /** Paqueteria operativo: seguimiento, monto y numero de factura, sin costos ni margen. */
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
    'Trámites con sus datos de seguimiento, peso y CNEE, sin montos ni costos internos.',
  [ReportKind.OperativoCompleto]:
    'Trámites con todo el detalle operativo, la cuenta Miami y el monto de factura aprobado.',
  [ReportKind.Transaccional]:
    'Historial de cambios de estado de cada trámite, con quién lo movió y cuándo.',
  [ReportKind.Financiero]:
    'Proformas emitidas en el rango: facturado, abonado, saldo y estatus de pago.',
  [ReportKind.PaqueteriaFull]:
    'Paquetes con todo: cobro, costos, costo neto, gross profit y margen.',
  [ReportKind.PaqueteriaOperativo]:
    'Paquetes con su seguimiento, entrega, monto y número de factura. Sin costos ni margen.',
  [ReportKind.AgenciamientoFull]:
    'Trámites con todo: cobro, depósito, costos asociados, impuestos, profit y factura electrónica.',
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
 * PAQUETERIA. Las columnas se declaran UNA vez (`PAQ`) y los dos reportes eligen
 * de ahi, cada uno en el orden que pidio el negocio (docs/reportes-revision.html).
 * El operativo ya no es un prefijo del FULL: lleva SERVICIO, que el FULL no, y no
 * lleva TIENDA ni CARRIER. Declarar la columna una sola vez es lo que evita que
 * las dos listas diverjan el dia que alguien renombre un encabezado.
 *
 * Los comentarios numerados son el puente con el mapeo de campos original del
 * negocio (numero de campo, no posicion); "+" son columnas fuera del mapeo.
 */
const PAQ = {
  clientName: { key: 'clientName', label: 'CLIENTE' }, //                     3
  hawb: { key: 'hawb', label: 'AWB (LES)' }, //                               9
  weightKg: { key: 'weightKg', label: 'PESO KG' }, //                        10
  tracking: { key: 'tracking', label: 'TRACKING' }, //                        4
  cnee: { key: 'cnee', label: 'CNEE' }, //                                    +
  description: { key: 'description', label: 'REF' }, //                       7
  state: { key: 'state', label: 'ESTATUS' }, //                              11
  code: { key: 'code', label: 'Consecutivo Interno HS' }, //                  2
  service: { key: 'service', label: 'SERVICIO' }, //                          1  constante
  miamiArrivalAt: { key: 'miamiArrivalAt', label: 'FECHA DE ARRIBO A MIAMI' }, // 8  derivado del historial
  store: { key: 'store', label: 'TIENDA' }, //                                5
  carrier: { key: 'carrier', label: 'CARRIER' }, //                           6
  deliveredAt: { key: 'deliveredAt', label: 'FECHA ENTREGA' }, //            12  derivado del historial
  month: { key: 'month', label: 'MES' }, //                                  13  mes de facturacion
  invoiceTotalUsd: { key: 'invoiceTotalUsd', label: 'MONTO FACTURA' }, //    15
  // "# de factura" es el de la factura ELECTRONICA: el negocio pide el numero de
  // proforma y el de FE por separado en el Financiero, asi que "factura" es la FE.
  electronicInvoiceNumber: { key: 'electronicInvoiceNumber', label: '# DE FACTURA (FE)' }, // 27
  collectionStatus: { key: 'collectionStatus', label: 'ESTATUS COBRO' }, //  16  derivado de los pagos
  bankAccount: { key: 'bankAccount', label: 'CUENTA' }, //                   17
  receipt: { key: 'receipt', label: 'COMPROBANTE' }, //                      18
  paidAt: { key: 'paidAt', label: 'FECHA DE PAGO' }, //                      19  derivado del pago
  proformaApprovedAt: { key: 'proformaApprovedAt', label: 'FECHA DE APROBACIÓN' }, // +
  billingNotes: { key: 'billingNotes', label: 'NOTAS P/FACTURAR' }, //      20
  internationalFreightUsd: { key: 'internationalFreightUsd', label: 'TRANSPORTE' }, // 21  calculado
  taxesUsd: { key: 'taxesUsd', label: 'IMPUESTOS' }, //                      22
  othersUsd: { key: 'othersUsd', label: 'OTROS / COMPRAS' }, //              23
  netCostUsd: { key: 'netCostUsd', label: 'COSTO NETO' }, //                 24  = 21+22+23
  grossProfitUsd: { key: 'grossProfitUsd', label: 'GROSS PROFIT' }, //       25  = 15-24
  marginPct: { key: 'marginPct', label: '%' }, //                            26  = 25/15
} as const satisfies Record<string, ReportColumn>;

const PAQUETERIA_FULL_COLUMNS: readonly ReportColumn[] = [
  PAQ.clientName,
  PAQ.hawb,
  PAQ.weightKg,
  PAQ.tracking,
  PAQ.cnee,
  PAQ.description,
  PAQ.state,
  PAQ.code,
  PAQ.miamiArrivalAt,
  PAQ.store,
  PAQ.carrier,
  PAQ.deliveredAt,
  PAQ.month,
  PAQ.invoiceTotalUsd,
  PAQ.electronicInvoiceNumber,
  PAQ.collectionStatus,
  PAQ.bankAccount,
  PAQ.receipt,
  PAQ.paidAt,
  PAQ.proformaApprovedAt,
  PAQ.billingNotes,
  PAQ.internationalFreightUsd,
  PAQ.taxesUsd,
  PAQ.othersUsd,
  PAQ.netCostUsd,
  PAQ.grossProfitUsd,
  PAQ.marginPct,
];

const PAQUETERIA_OPERATIONAL_COLUMNS: readonly ReportColumn[] = [
  PAQ.clientName,
  PAQ.hawb,
  PAQ.weightKg,
  PAQ.tracking,
  PAQ.cnee,
  PAQ.description,
  PAQ.state,
  PAQ.code,
  PAQ.service,
  PAQ.miamiArrivalAt,
  PAQ.deliveredAt,
  PAQ.month,
  PAQ.invoiceTotalUsd,
  PAQ.electronicInvoiceNumber,
];

/**
 * AGENCIAMIENTO y transporte, los 23 campos del mapeo. El orden lo pidio el
 * negocio (cliente, AWB/BL, servicio, ref, DUA, estatus, consecutivo, almacen,
 * mes, fecha facturacion, proforma, monto, notas p/facturar y luego el resto) y
 * no coincide con la numeracion del mapeo, que se conserva en los comentarios.
 *
 * A diferencia de Paqueteria, el operativo NO es un prefijo: NOTAS P/FACTURAR
 * (solo FULL) va en medio de los campos operativos. El operativo se arma
 * quitando las claves de `AGENCIAMIENTO_FULL_ONLY_KEYS` (campos 1 al 18).
 *
 * Los montos van en COLONES: es la moneda en que se le cobra a este flujo
 * (`chargeCurrencyOf`), y la del deposito que se compara contra la factura en
 * DIF. El encabezado lo dice para que el CSV no dependa de saberlo.
 */
const AGENCIAMIENTO_COLUMNS: readonly ReportColumn[] = [
  { key: 'clientName', label: 'CLIENTE' }, //                       4
  { key: 'tracking', label: 'AWB / BL' }, //                        5
  { key: 'shipmentType', label: 'SERVICIO' }, //                    2
  { key: 'description', label: 'REF' }, //                          6
  { key: 'dua', label: 'DUA' }, //                                  7
  { key: 'state', label: 'ESTATUS' }, //                            8
  { key: 'code', label: 'Consecutivo Interno HS' }, //              1
  { key: 'warehouse', label: 'ALMACEN' }, //                        3
  { key: 'month', label: 'MES' }, //                               10  derivado de 9
  { key: 'invoicedAt', label: 'FECHA FACTURACIÓN' }, //             9
  { key: 'proforma', label: 'PROFORMA' }, //                       11  consecutivo propio
  { key: 'invoiceTotalCrc', label: 'MONTO FACTURA (CRC)' }, //     12
  { key: 'billingNotes', label: 'NOTAS P/FACTURAR' }, //           19  solo FULL
  { key: 'collectionStatus', label: 'ESTATUS COBRO' }, //          13  derivado de los pagos
  { key: 'bankAccount', label: 'CUENTA' }, //                      14
  { key: 'receipt', label: 'COMPROBANTE DEPOSITO' }, //            15
  { key: 'paidAt', label: 'FECHA DEPOSITO' }, //                   16  derivado del pago
  { key: 'depositedCrc', label: 'MONTO DEPOSITADO (CRC)' }, //    17  derivado de los abonos
  { key: 'differenceCrc', label: 'DIF (CRC)' }, //                 18  = 12-17
  // --- A partir de aqui, solo el reporte FULL (admin) ---
  // Fecha de aprobacion de la proforma (fuera del mapeo original: sin numero).
  // Vacia si el tramite no esta en una proforma aprobada (p. ej. costos
  // aprobados antes del modulo de proformas).
  { key: 'proformaApprovedAt', label: 'FECHA DE APROBACIÓN DE LA PROFORMA' }, // +
  // Costos asociados (campo 20) se partio en dos a pedido del negocio: los
  // impuestos van en su propia columna y COSTO NETO suma las dos.
  { key: 'associatedCostsCrc', label: 'COSTOS ASOCIADOS (CRC)' }, // 20  lineas "otros"
  { key: 'taxesCrc', label: 'IMPUESTOS (CRC)' }, //                  +   lineas "impuestos"
  { key: 'netCostCrc', label: 'COSTO NETO (CRC)' }, //               +   = asociados + impuestos
  { key: 'profitCrc', label: 'PROFIT (CRC)' }, //                  21  = 12 - costo neto
  { key: 'marginPct', label: '%' }, //                             22  = 21/12
  { key: 'electronicInvoiceNumber', label: 'FE' }, //              23
];

/**
 * Columnas de Agenciamiento que solo ve el FULL (campos 19 al 23 y los "+").
 * Todo lo demas (campos 1 al 18) lo ve tambien el operativo.
 */
const AGENCIAMIENTO_FULL_ONLY_KEYS: ReadonlySet<string> = new Set([
  'billingNotes',
  'proformaApprovedAt',
  'associatedCostsCrc',
  'taxesCrc',
  'netCostCrc',
  'profitCrc',
  'marginPct',
  'electronicInvoiceNumber',
]);

/**
 * Columnas de cada reporte, en orden. El Basico es un SUBCONJUNTO del Completo:
 * lo que le falta al basico (montos de factura, datos internos de bodega) es lo
 * que no debe ver el personal no administrador. El peso SI lo ve: no es un monto
 * y el negocio lo pidio para atender al cliente.
 *
 * "Última actualización" es el ultimo cambio de ESTADO del tramite (su
 * historial), no `updated_at`, que se mueve con cualquier edicion tecnica
 * (sincronizacion con Helga, correcciones). El filtro de fechas de los
 * operativos usa esa misma fecha (ver `reportsRepo.shipments`).
 */
export const REPORT_COLUMNS: Record<ReportKind, readonly ReportColumn[]> = {
  [ReportKind.OperativoBasico]: [
    { key: 'code', label: 'Consecutivo' },
    { key: 'shipmentType', label: 'Trámite' },
    { key: 'clientName', label: 'Cliente' },
    { key: 'tracking', label: 'Tracking / AWB / BL' },
    { key: 'hawb', label: 'HAWB (LES)' },
    { key: 'weightKg', label: 'Peso (kg)' },
    { key: 'cnee', label: 'CNEE' },
    { key: 'description', label: 'Descripción (REF)' },
    { key: 'state', label: 'Estatus' },
    { key: 'routeNumber', label: 'Ruta' },
    { key: 'lastMovedAt', label: 'Última actualización' },
  ],

  [ReportKind.OperativoCompleto]: [
    { key: 'code', label: 'Consecutivo' },
    { key: 'shipmentType', label: 'Trámite' },
    { key: 'clientCode', label: 'Casillero' },
    { key: 'miamiAccount', label: 'Cuenta Miami' },
    { key: 'clientName', label: 'Cliente' },
    { key: 'tracking', label: 'Tracking / AWB / BL' },
    { key: 'description', label: 'Descripción (REF)' },
    { key: 'cnee', label: 'CNEE' },
    { key: 'store', label: 'Tienda' },
    { key: 'carrier', label: 'Transportista' },
    { key: 'hawb', label: 'HAWB (LES) / HBL' },
    { key: 'weightKg', label: 'Peso (kg)' },
    { key: 'warehouse', label: 'Almacén' },
    { key: 'dua', label: 'DUA' },
    { key: 'state', label: 'Estatus' },
    { key: 'routeNumber', label: 'Ruta' },
    { key: 'invoiceTotalUsd', label: 'Factura (USD)' },
    { key: 'invoiceTotalCrc', label: 'Factura (CRC)' },
    { key: 'lastMovedAt', label: 'Última actualización' },
  ],

  [ReportKind.Transaccional]: [
    { key: 'code', label: 'Consecutivo' },
    { key: 'shipmentType', label: 'Trámite' },
    { key: 'clientName', label: 'Cliente' },
    { key: 'tracking', label: 'Tracking / AWB / BL' },
    { key: 'hawb', label: 'HAWB (LES)' },
    { key: 'state', label: 'Estado' },
    { key: 'note', label: 'Comentario' },
    { key: 'createdByName', label: 'Registrado por' },
    { key: 'createdAt', label: 'Fecha del movimiento' },
  ],

  /**
   * Estado de cuenta: UNA FILA POR PROFORMA emitida (aprobada o pagada) en el
   * rango, no por tramite. La pregunta del reporte es cuanto debe el cliente, y
   * lo que se le cobra es la proforma entera.
   *
   * Los montos van en la moneda en que se COBRA la proforma (columna Moneda), y
   * al lado su equivalente en dolares con la tasa congelada en la aprobacion:
   * una columna homogenea que si se puede sumar en la hoja de calculo.
   */
  [ReportKind.Financiero]: [
    { key: 'clientCode', label: 'Casillero' },
    { key: 'miamiAccount', label: 'Cuenta Miami' },
    { key: 'clientName', label: 'Cliente' },
    { key: 'proforma', label: '# Proforma' },
    { key: 'approvedAt', label: 'Fecha proforma' },
    { key: 'electronicInvoiceNumber', label: '# FE' },
    { key: 'shipmentCount', label: 'Paquetes / trámites' },
    { key: 'weightKg', label: 'Peso facturado (kg)' },
    { key: 'currency', label: 'Moneda' },
    { key: 'invoiced', label: 'Facturado' },
    { key: 'settled', label: 'Abonado' },
    { key: 'balance', label: 'Saldo' },
    { key: 'invoicedUsd', label: 'Facturado (USD)' },
    { key: 'balanceUsd', label: 'Saldo (USD)' },
    { key: 'paymentStatus', label: 'Estatus de pago' },
    { key: 'paidAt', label: 'Fecha de pago' },
  ],

  /**
   * En Agenciamiento el operativo se DERIVA del FULL filtrando por clave: dos
   * listas escritas a mano acabarian divergiendo. En Paqueteria las dos listas
   * eligen de `PAQ`, que cumple el mismo papel.
   */
  [ReportKind.PaqueteriaFull]: PAQUETERIA_FULL_COLUMNS,
  [ReportKind.PaqueteriaOperativo]: PAQUETERIA_OPERATIONAL_COLUMNS,
  [ReportKind.AgenciamientoFull]: AGENCIAMIENTO_COLUMNS,
  [ReportKind.AgenciamientoOperativo]: AGENCIAMIENTO_COLUMNS.filter(
    (column) => !AGENCIAMIENTO_FULL_ONLY_KEYS.has(column.key),
  ),
};

/** Fila de un reporte: valores ya listos para mostrar (la API los serializa). */
export type ReportRow = Record<string, string | number | null>;

/** Reporte generado: sus columnas y sus filas. */
export interface ReportDto {
  kind: ReportKind;
  columns: readonly ReportColumn[];
  rows: ReportRow[];
}
