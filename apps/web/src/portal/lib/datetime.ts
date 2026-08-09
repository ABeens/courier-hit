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
 * Instante ISO (UTC) -> sello de la linea de tiempo: `25 may 2026 · 08:00`.
 *
 * Formato distinto al de `formatDateTime` a proposito. Ahi la fecha se lee de una
 * en una y el numero es lo comodo; aqui se recorre una columna de sellos uno
 * debajo de otro, y con el mes en letra no hay que descifrar si `05/06` es mayo o
 * junio al saltar de una fila a la siguiente.
 */
export function formatStamp(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString('es-CR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const time = date.toLocaleTimeString('es-CR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${day} · ${time}`;
}

/**
 * Dia elegido en un <input type="date"> (YYYY-MM-DD) -> como se escribe en es-CR.
 *
 * Aqui NO hay conversion de zona: ese valor ya es un dia del calendario local
 * del usuario, no un instante. Pasarlo por `new Date(...)` lo leeria como UTC y
 * lo correria un dia hacia atras en Costa Rica.
 */
export function formatDayInput(day: string): string {
  const [y, m, d] = day.split('-');
  return d && m && y ? `${d}/${m}/${y}` : day;
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
