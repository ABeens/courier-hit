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

export enum ReportKind {
  /** Columnas limitadas: sirve para atender al cliente sin ver costos internos. */
  OperativoBasico = 'operativo_basico',
  /** Todo el detalle operativo, incluido el monto de factura. */
  OperativoCompleto = 'operativo_completo',
  /** Movimiento de estados: que paso con cada tramite y cuando. */
  Transaccional = 'transaccional',
  /** Facturacion y saldos por cliente (estado de cuenta). */
  Financiero = 'financiero',
}

export const REPORT_LABELS: Record<ReportKind, string> = {
  [ReportKind.OperativoBasico]: 'Operativo básico',
  [ReportKind.OperativoCompleto]: 'Operativo completo',
  [ReportKind.Transaccional]: 'Transaccional',
  [ReportKind.Financiero]: 'Financiero — estado de cuenta',
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
};

/** Permiso que habilita cada reporte (docs/manuales/roles.md §2). */
export const REPORT_PERMISSIONS: Record<ReportKind, Permission> = {
  [ReportKind.OperativoBasico]: Permission.ReportsOperationalBasic,
  [ReportKind.OperativoCompleto]: Permission.ReportsOperationalFull,
  [ReportKind.Transaccional]: Permission.ReportsOperationalFull,
  [ReportKind.Financiero]: Permission.ReportsFinancial,
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
};

/** Fila de un reporte: valores ya listos para mostrar (la API los serializa). */
export type ReportRow = Record<string, string | number | null>;

/** Reporte generado: sus columnas y sus filas. */
export interface ReportDto {
  kind: ReportKind;
  columns: readonly ReportColumn[];
  rows: ReportRow[];
}
