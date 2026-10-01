/**
 * Auditoria de correcciones administrativas.
 *
 * Una correccion no tiene tabla propia: es un asiento del historial del tramite
 * (`shipment_events`) cuya nota empieza por `CORRECTION_NOTE_PREFIX`. Lo escriben
 * todas las puertas de enmienda (corregir estado, devolver una proforma a
 * borrador, cambiar el dueño, descartar y restaurar, registrar un paquete sin
 * dueño), siempre con el comentario de quien la hizo.
 *
 * El TIPO de correccion tampoco es columna: se reconoce por el texto fijo que
 * cada puerta pone despues del prefijo. Los patrones viven aqui, en UN solo
 * sitio, porque los leen dos capas: la API (filtra en SQL con LIKE) y quien
 * clasifica la fila ya cargada. Si una puerta cambia su texto, cambia aqui.
 */
import { z } from 'zod';
import { paginationQuerySchema } from '../http/pagination';
import { CORRECTION_NOTE_PREFIX } from '../shipments/shipment';
import type { ShipmentType } from '../workflow/shipment-type';
import type { State } from '../workflow/states';

/** Tipo de correccion (dominio). */
export enum CorrectionKind {
  /** Correccion libre del estado (`transitionsService.correct`). */
  Estado = 'estado',
  /** Proforma aprobada devuelta a borrador (`proformasService.correct`). */
  Proforma = 'proforma',
  /** Dueño asignado o cambiado desde la sala de control. */
  Dueno = 'dueno',
  Descarte = 'descarte',
  DescarteDeshecho = 'descarte_deshecho',
  /** Paquete dado de alta en bodega sin prealerta ni dueño. */
  RegistroSinDueno = 'registro_sin_dueno',
}

export const CORRECTION_KIND_LABELS: Record<CorrectionKind, string> = {
  [CorrectionKind.Estado]: 'Estado corregido',
  [CorrectionKind.Proforma]: 'Proforma devuelta a borrador',
  [CorrectionKind.Dueno]: 'Cambio de dueño',
  [CorrectionKind.Descarte]: 'Paquete descartado',
  [CorrectionKind.DescarteDeshecho]: 'Descarte deshecho',
  [CorrectionKind.RegistroSinDueno]: 'Registro sin dueño',
};

/**
 * Patron LIKE (sin el prefijo) del texto fijo de cada puerta. `Estado` no tiene:
 * su nota es solo el comentario del admin, asi que es "lo que no es ninguno de
 * los demas".
 */
export const CORRECTION_KIND_PATTERNS: Partial<Record<CorrectionKind, string>> = {
  [CorrectionKind.Proforma]: 'proforma % devuelta a borrador.%',
  [CorrectionKind.Dueno]: 'dueño cambiado de %',
  [CorrectionKind.Descarte]: 'paquete descartado.%',
  [CorrectionKind.DescarteDeshecho]: 'descarte deshecho:%',
  [CorrectionKind.RegistroSinDueno]: 'paquete encontrado en bodega sin aviso previo.%',
};

/** LIKE -> RegExp anclada, para clasificar con el MISMO patron que filtra el SQL. */
function likeToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('%')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  return new RegExp(`^${body}$`);
}

/** Tipo de una nota de correccion (con o sin el prefijo). */
export function correctionKindOf(note: string): CorrectionKind {
  const text = note.startsWith(CORRECTION_NOTE_PREFIX) ? note.slice(CORRECTION_NOTE_PREFIX.length) : note;
  for (const [kind, pattern] of Object.entries(CORRECTION_KIND_PATTERNS)) {
    if (pattern && likeToRegExp(pattern).test(text)) return kind as CorrectionKind;
  }
  return CorrectionKind.Estado;
}

const instantSchema = z.string().datetime({ offset: true, message: 'Fecha inválida.' });

/** Filtros del listado de auditoria. Todos se aplican en SQL. */
export const listCorrectionsQuerySchema = z
  .object({
    /** Busca en el comentario, el consecutivo, el tracking, el casillero y en quien corrigio. */
    q: z.string().trim().optional(),
    kind: z.nativeEnum(CorrectionKind).optional(),
    /** Inicio del rango por fecha de la correccion, inclusive. */
    from: instantSchema.optional(),
    /** Fin del rango, exclusivo (la web manda el inicio del dia siguiente). */
    to: instantSchema.optional(),
  })
  .merge(paginationQuerySchema);
export type ListCorrectionsQuery = z.infer<typeof listCorrectionsQuerySchema>;

/** Fila de la auditoria: la correccion y el tramite sobre el que se hizo. */
export interface CorrectionDto {
  id: string;
  /** Instante UTC en ISO 8601; la vista lo convierte a hora local. */
  createdAt: string;
  kind: CorrectionKind;
  /** Nota completa SIN el prefijo de correccion (incluye el comentario). */
  note: string;
  /** Estado en que quedo el tramite tras la correccion. */
  state: State;
  /** Estado del asiento anterior del historial; null si fue el primero. */
  previousState: State | null;
  shipmentId: string;
  shipmentCode: string;
  tracking: string;
  shipmentType: ShipmentType;
  /** Dueño ACTUAL del tramite (null si sigue sin dueño). */
  clientCode: string | null;
  clientName: string | null;
  /** Quien hizo la correccion; null si el usuario ya no existe. */
  authorName: string | null;
}
