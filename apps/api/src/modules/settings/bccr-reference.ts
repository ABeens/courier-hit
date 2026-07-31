/**
 * Tasa de cambio de REFERENCIA del dia (BCCR, indicador de tipo de cambio de
 * venta).
 *
 * Regla del negocio: el BCCR informa, el administrador decide. Ningun monto se
 * guarda con este valor: la tasa que usa el sistema es la que alguien con
 * `exchange_rate.write` fijo en Configuración (`settingsRepo`), y esto solo se
 * muestra al lado para ayudar a decidirla. Por eso todo fallo aqui devuelve
 * `null` en vez de lanzar: una caida del BCCR no puede impedir facturar.
 *
 * Convencion del sistema: la tasa es COLONES POR 1 USD.
 */
import { bccrReady, config } from '../../core/config';

/** Referencia del dia: el valor y de donde salio (para poder mostrarlo). */
export interface ExchangeRateSuggestion {
  /** Colones por 1 USD, o null si no se pudo obtener. */
  rate: number | null;
  source: 'bccr' | 'none';
  /** Fecha del indicador consultado (ISO, UTC); null si no hubo dato. */
  date: string | null;
}

const NO_RATE: ExchangeRateSuggestion = { rate: null, source: 'none', date: null };

/** Formato de fecha que exige el web service del BCCR: dd/mm/aaaa. */
function bccrDate(now: Date): string {
  const d = String(now.getUTCDate()).padStart(2, '0');
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${now.getUTCFullYear()}`;
}

/**
 * Extrae el primer `<NUM_VALOR>` de la respuesta XML. Es una extraccion
 * deliberadamente minima: no vale la pena una dependencia de parseo de XML para
 * leer un unico numero de un formato que lleva anios estable.
 */
function parseRate(xml: string): number | null {
  const match = /<NUM_VALOR>([^<]+)<\/NUM_VALOR>/i.exec(xml);
  if (!match?.[1]) return null;
  const value = Number(match[1].trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const exchangeRateReference = {
  /**
   * Referencia del BCCR para hoy. Devuelve `NO_RATE` (sin lanzar) si la
   * integracion esta apagada, si el BCCR responde mal o si la llamada se pasa
   * del timeout.
   */
  async suggest(now = new Date()): Promise<ExchangeRateSuggestion> {
    // `bccrReady` = bandera encendida Y credenciales cargadas. Encendida sin
    // credenciales se comporta igual que apagada: sin sugerencia, sin error.
    if (!bccrReady) return NO_RATE;

    try {
      const day = bccrDate(now);
      // Dentro del try a proposito: si la URL configurada es basura, `new URL`
      // lanza, y eso tampoco debe tumbar la pantalla de costos.
      const url = new URL(config.BCCR_BASE_URL!);
      url.searchParams.set('Indicador', String(config.BCCR_INDICATOR));
      url.searchParams.set('FechaInicio', day);
      url.searchParams.set('FechaFinal', day);
      url.searchParams.set('Nombre', config.BCCR_NAME!);
      url.searchParams.set('SubNiveles', 'N');
      url.searchParams.set('CorreoElectronico', config.BCCR_EMAIL!);
      url.searchParams.set('Token', config.BCCR_TOKEN!);

      const response = await fetch(url, {
        signal: AbortSignal.timeout(config.BCCR_TIMEOUT_MS),
      });
      if (!response.ok) return NO_RATE;
      const rate = parseRate(await response.text());
      if (rate === null) return NO_RATE;
      return { rate, source: 'bccr', date: now.toISOString() };
    } catch (err) {
      // La referencia es opcional; que falle no debe ensuciar el log de errores
      // reales ni romper la pantalla que la muestra.
      console.warn('[settings] no se pudo obtener la tasa del BCCR:', (err as Error).message);
      return NO_RATE;
    }
  },
};
