/**
 * Anuncios manuales del panel admin — in-app banner alerts del portal del
 * cliente (docs/manuales/roles.md §3). No cubre los avisos automaticos del
 * sistema (p. ej. "paquete esperando tu pago"): esos conviven aparte (§3.2).
 *
 * Regla central del modulo: el ESTADO NO SE ALMACENA, se deriva. En la BD solo
 * viven `enabled` (lo que el admin conmuta) y la vigencia `startsAt`/`endsAt`.
 * Activo / Programado / Vencido / Inactivo salen de comparar la vigencia con el
 * instante actual, asi que un anuncio caduca solo, sin job ni intervencion
 * manual (§3.4.5). Esta funcion es la unica fuente: la usa el listado del admin
 * y el filtro del endpoint del portal.
 */

/** Severidad del aviso (§3.2). Determina color y orden de apilado. */
export enum AnnouncementType {
  Informativo = 'informativo',
  Advertencia = 'advertencia',
  Critico = 'critico',
}

export const ANNOUNCEMENT_TYPE_LABELS: Record<AnnouncementType, string> = {
  [AnnouncementType.Informativo]: 'Informativo',
  [AnnouncementType.Advertencia]: 'Advertencia',
  [AnnouncementType.Critico]: 'Crítico',
};

/**
 * Peso de apilado: Critico → Advertencia → Informativo (§3.4.2). Mayor primero.
 * Se comparte con la API para que el ORDER BY del SQL y el orden que ve el admin
 * no puedan divergir.
 */
export const ANNOUNCEMENT_TYPE_WEIGHT: Record<AnnouncementType, number> = {
  [AnnouncementType.Critico]: 3,
  [AnnouncementType.Advertencia]: 2,
  [AnnouncementType.Informativo]: 1,
};

/** Estado derivado que se muestra en el listado del admin (§3.3.3). */
export enum AnnouncementStatus {
  /** Habilitado y dentro de vigencia: se esta publicando ahora. */
  Activo = 'activo',
  /** Habilitado pero su vigencia aun no empieza. */
  Programado = 'programado',
  /** Su vigencia ya paso. */
  Vencido = 'vencido',
  /** Apagado por el admin, sin importar la vigencia. */
  Inactivo = 'inactivo',
}

export const ANNOUNCEMENT_STATUS_LABELS: Record<AnnouncementStatus, string> = {
  [AnnouncementStatus.Activo]: 'Activo',
  [AnnouncementStatus.Programado]: 'Programado',
  [AnnouncementStatus.Vencido]: 'Vencido',
  [AnnouncementStatus.Inactivo]: 'Inactivo',
};

/** Limites de texto del formulario (§3.3.2). Los aplica el DTO y el input. */
export const ANNOUNCEMENT_TITLE_MAX = 60;
export const ANNOUNCEMENT_MESSAGE_MAX = 200;

/** Lo minimo para derivar el estado: no exige el registro completo. */
export interface AnnouncementSchedule {
  enabled: boolean;
  startsAt: Date | string;
  endsAt: Date | string;
}

/**
 * Estado derivado en el instante `now`. `enabled` manda: un anuncio apagado es
 * Inactivo aunque su vigencia sea la de hoy — al reactivarlo vuelve a caer en la
 * casilla que le corresponda por fecha.
 */
export function announcementStatus(a: AnnouncementSchedule, now: Date = new Date()): AnnouncementStatus {
  if (!a.enabled) return AnnouncementStatus.Inactivo;
  const t = now.getTime();
  if (t < new Date(a.startsAt).getTime()) return AnnouncementStatus.Programado;
  if (t > new Date(a.endsAt).getTime()) return AnnouncementStatus.Vencido;
  return AnnouncementStatus.Activo;
}

/** Un anuncio se publica solo si esta Activo (§3.3.5). */
export function isAnnouncementLive(a: AnnouncementSchedule, now: Date = new Date()): boolean {
  return announcementStatus(a, now) === AnnouncementStatus.Activo;
}

/** Maximo de banners simultaneos en el portal (§3.4.2). */
export const ANNOUNCEMENT_VISIBLE_LIMIT = 3;

/** Valores para construir el enum de Postgres (Drizzle pgEnum). */
export const ANNOUNCEMENT_TYPE_VALUES = Object.values(AnnouncementType) as [
  AnnouncementType,
  ...AnnouncementType[],
];
