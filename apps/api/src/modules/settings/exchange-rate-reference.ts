/**
 * Tasa de cambio de REFERENCIA del dia (tipo de cambio de VENTA del dolar).
 *
 * FUENTE: la API de indicadores del Ministerio de Hacienda
 * (`api.hacienda.go.cr/indicadores/tc/dolar`), que republica el tipo de cambio
 * oficial del BCCR en JSON, sin suscripcion, sin token y sin credenciales que
 * caduquen.
 *
 * Antes se consultaba el web service del BCCR directamente. Se cambio porque
 * aquel endpoint exigia un tramite de suscripcion (nombre + correo + token) para
 * un dato publico, y ademas quedo devolviendo 503. Hacienda publica el MISMO
 * numero: la fuente primaria del indicador sigue siendo el BCCR.
 *
 * Regla del negocio (no cambia): la fuente informa, el administrador decide.
 * Ningun monto se guarda con este valor: la tasa que usa el sistema es la que
 * alguien con `exchange_rate.write` fijo en Configuración (`settingsRepo`), y
 * esto solo se muestra al lado para ayudar a decidirla. Por eso todo fallo aqui
 * devuelve `null` en vez de lanzar: una caida de la fuente no puede impedir
 * facturar.
 *
 * Convencion del sistema: la tasa es COLONES POR 1 USD.
 */
import { globalExchangeRateSchema } from '@courier/shared';
import { config } from '../../core/config';

/** Referencia del dia: el valor y de donde salio (para poder mostrarlo). */
export interface ExchangeRateSuggestion {
  /** Colones por 1 USD, o null si no se pudo obtener. */
  rate: number | null;
  source: 'hacienda' | 'none';
  /**
   * DIA del indicador (AAAA-MM-DD), no un instante: la fuente publica un valor
   * por dia calendario de Costa Rica, sin hora. Null si no hubo dato.
   */
  day: string | null;
}

const NO_RATE: ExchangeRateSuggestion = { rate: null, source: 'none', day: null };

/** Forma del JSON de Hacienda: `{ venta: {fecha, valor}, compra: {...} }`. */
interface HaciendaResponse {
  venta?: { fecha?: unknown; valor?: unknown };
  compra?: { fecha?: unknown; valor?: unknown };
}

/**
 * Un dia calendario, tal cual lo publica la fuente. Se valida el formato en vez
 * de pasarlo por `new Date`: convertirlo a instante lo correria un dia hacia
 * atras en Costa Rica (UTC-6) y la pantalla mostraria la fecha equivocada.
 */
function parseDay(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * El valor solo se acepta si pasaria como tasa vigente del sistema
 * (`globalExchangeRateSchema`: positiva y con techo). Es deliberado usar el
 * MISMO esquema: la referencia existe para ofrecerse con el boton "Usar esta",
 * asi que un numero que el administrador no podria guardar tampoco sirve como
 * sugerencia.
 */
function parseRate(value: unknown): number | null {
  const result = globalExchangeRateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export const exchangeRateReference = {
  /**
   * Referencia de hoy. Devuelve `NO_RATE` (sin lanzar) si la integracion esta
   * apagada, si la fuente responde mal o si la llamada se pasa del timeout.
   */
  async suggest(): Promise<ExchangeRateSuggestion> {
    if (!config.HACIENDA_ENABLED) return NO_RATE;

    try {
      const response = await fetch(config.HACIENDA_BASE_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(config.HACIENDA_TIMEOUT_MS),
      });
      if (!response.ok) {
        // Se registra el codigo a proposito: sin esto, una fuente caida y un
        // valor ilegible se ven identicos desde la pantalla ("no hay
        // referencia") y no hay forma de distinguirlos sin salir a curl.
        console.warn(`[settings] la fuente de la tasa respondió ${response.status}`);
        return NO_RATE;
      }

      // VENTA, no compra: es el tipo de cambio al que se le vende el dolar al
      // cliente, o sea el que corresponde a lo que se le cobra.
      const body = (await response.json()) as HaciendaResponse;
      const rate = parseRate(body.venta?.valor);
      if (rate === null) return NO_RATE;
      return { rate, source: 'hacienda', day: parseDay(body.venta?.fecha) };
    } catch (err) {
      // La referencia es opcional; que falle no debe ensuciar el log de errores
      // reales ni romper la pantalla que la muestra.
      console.warn('[settings] no se pudo obtener la tasa de referencia:', (err as Error).message);
      return NO_RATE;
    }
  },
};
