/**
 * Conversion entre los instantes UTC que maneja la API y la hora local del
 * usuario. Es la UNICA capa donde ocurre esa conversion (CLAUDE.md: almacenar y
 * transportar en UTC, mostrar en hora local); ninguna otra parte del portal debe
 * construir fechas a mano.
 */

/** Instante ISO (UTC) -> fecha corta en la hora local del usuario. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** Instante ISO (UTC) -> fecha y hora en la hora local del usuario. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-CR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Dia elegido en un <input type="date"> (YYYY-MM-DD, hora local) -> instante UTC
 * del ARRANQUE de ese dia. Es el extremo inclusivo de un filtro de rango.
 */
export function startOfLocalDayUtc(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 0, 0, 0, 0).toISOString();
}

/**
 * Igual pero el arranque del DIA SIGUIENTE: es el extremo exclusivo, de modo que
 * el ultimo dia del rango entra completo (incluidas sus 23:59).
 */
export function startOfNextLocalDayUtc(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d! + 1, 0, 0, 0, 0).toISOString();
}
