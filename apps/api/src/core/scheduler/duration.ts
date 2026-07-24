/**
 * Parseo y formateo de duraciones legibles: "2h", "30m", "90s", "500ms",
 * "1d", "1h30m". Es la pieza que permite configurar cada tarea del scheduler
 * "cada N <unidad>" sin atarse a una unidad fija: el operador escribe la
 * cadena y aqui la convertimos SIEMPRE a milisegundos, que es la unidad con la
 * que trabaja `setTimeout`.
 *
 * Unidades soportadas (con alias en ingles y espanol):
 *   ms  milisegundos
 *   s   segundos   (sec, second, seconds, segundo, segundos)
 *   m   minutos    (min, minute, minutes, minuto, minutos)
 *   h   horas      (hr, hour, hours, hora, horas)
 *   d   dias       (day, days, dia, dias)
 *   w   semanas    (week, weeks, semana, semanas)
 *
 * DELIBERADAMENTE se para en semanas: meses y anios no tienen una duracion fija
 * en milisegundos (28-31 dias, anios bisiestos), asi que expresarlos aqui seria
 * mentir. Una tarea "mensual" es responsabilidad de un cron de calendario, no de
 * un intervalo de milisegundos.
 */

/** Milisegundos de cada unidad canonica. */
const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

type CanonicalUnit = keyof typeof UNIT_MS;

/** Cada alias aceptado apunta a su unidad canonica. */
const UNIT_ALIASES: Record<string, CanonicalUnit> = {
  ms: 'ms',
  milli: 'ms',
  millis: 'ms',
  millisecond: 'ms',
  milliseconds: 'ms',
  milisegundo: 'ms',
  milisegundos: 'ms',

  s: 's',
  sec: 's',
  secs: 's',
  second: 's',
  seconds: 's',
  segundo: 's',
  segundos: 's',

  m: 'm',
  min: 'm',
  mins: 'm',
  minute: 'm',
  minutes: 'm',
  minuto: 'm',
  minutos: 'm',

  h: 'h',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',
  hora: 'h',
  horas: 'h',

  d: 'd',
  day: 'd',
  days: 'd',
  dia: 'd',
  dias: 'd',

  w: 'w',
  wk: 'w',
  week: 'w',
  weeks: 'w',
  semana: 'w',
  semanas: 'w',
};

/** Un termino de la cadena: numero + unidad, p. ej. "30m" o "1.5h". */
const TERM = /(\d+(?:\.\d+)?)\s*([a-zµ]+)/giu;

/**
 * Convierte una duracion legible a milisegundos.
 *
 * Acepta uno o varios terminos concatenados ("1h30m", "2d 4h"): se suman. Lanza
 * si la cadena esta vacia, tiene una unidad desconocida o contiene texto que no
 * encaja en el formato (preferimos fallar al arrancar que agendar una tarea con
 * un intervalo que el operador escribio mal).
 *
 * @example parseDuration('90s')    // 90_000
 * @example parseDuration('1h30m')  // 5_400_000
 * @example parseDuration('2d')     // 172_800_000
 */
export function parseDuration(input: string): number {
  const text = input.trim().toLowerCase();
  if (text === '') {
    throw new Error('Duracion vacia: escribe algo como "15m", "2h" o "1d".');
  }

  let total = 0;
  let matchedChars = 0;
  let terms = 0;

  for (const match of text.matchAll(TERM)) {
    const [whole, rawValue, rawUnit] = match;
    // Los grupos siempre existen si el termino encajo; el guard es solo para el
    // tipo (matchAll los declara opcionales).
    if (rawValue === undefined || rawUnit === undefined) continue;
    const unit = UNIT_ALIASES[rawUnit];
    if (unit === undefined) {
      throw new Error(
        `Unidad de tiempo desconocida: "${rawUnit}" en "${input}". ` +
          'Usa ms, s, m, h, d o w (o sus nombres completos).',
      );
    }
    total += Number(rawValue) * UNIT_MS[unit];
    // Contamos sin espacios: un termino como "2 minutos" trae un espacio interno
    // que el `\s*` del patron admite, pero abajo comparamos contra la cadena ya
    // sin espacios.
    matchedChars += whole.replace(/\s+/g, '').length;
    terms += 1;
  }

  // Si lo que reconocimos no cubre toda la cadena (descontando espacios), es que
  // habia basura entre medias: no adivinamos, avisamos.
  if (terms === 0 || matchedChars !== text.replace(/\s+/g, '').length) {
    throw new Error(
      `Duracion invalida: "${input}". Formato esperado: <numero><unidad>, ` +
        'p. ej. "500ms", "30m", "2h", "1d" o "1h30m".',
    );
  }

  if (total <= 0) {
    throw new Error(`Duracion invalida: "${input}" debe ser mayor que cero.`);
  }

  return total;
}

/** True si la cadena es una duracion valida (para validar config sin try/catch). */
export function isValidDuration(input: string): boolean {
  try {
    parseDuration(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Formatea milisegundos a una cadena compacta y legible ("1h30m", "45s").
 * Se usa solo para los logs del scheduler; no es la inversa exacta de
 * `parseDuration` (nunca emite terminos con valor cero).
 */
export function formatDuration(ms: number): string {
  if (ms < UNIT_MS.s) return `${ms}ms`;

  const order: CanonicalUnit[] = ['w', 'd', 'h', 'm', 's'];
  const parts: string[] = [];
  let remaining = Math.floor(ms / UNIT_MS.s) * UNIT_MS.s; // descarta ms sueltos

  for (const unit of order) {
    const size = UNIT_MS[unit];
    const qty = Math.floor(remaining / size);
    if (qty > 0) {
      parts.push(`${qty}${unit}`);
      remaining -= qty * size;
    }
  }

  return parts.join('') || '0s';
}
