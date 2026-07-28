/**
 * Pasarela de pago: Onvo Pay (Costa Rica). Ver https://docs.onvopay.com
 *
 * La tarjeta NUNCA toca nuestro backend: aqui solo se crea el intento de cobro y
 * el navegador monta el formulario de Onvo con el id de ese intento. Eso es lo que
 * nos mantiene fuera del alcance de PCI.
 *
 * Tres cosas de Onvo que NO funcionan como en otras pasarelas, y que explican la
 * forma de este archivo:
 *
 * 1. NO HAY `clientSecret`. El SDK del navegador se inicializa con la llave
 *    publicable y el ID del intento (`paymentIntentId`), no con un secreto de un
 *    solo uso. Por eso `PaymentIntent` expone `paymentIntentId` y no otra cosa.
 * 2. EL WEBHOOK NO VA FIRMADO. Onvo manda el secreto TAL CUAL en el header
 *    `X-Webhook-Secret`; no es un HMAC del cuerpo. Verificarlo es comparar dos
 *    cadenas, pero en tiempo constante (ver `verifyWebhookSecret`).
 * 3. EL EVENTO NO TRAE ID PROPIO. El cuerpo es `{type, data}` y nada mas, asi que
 *    la idempotencia no puede apoyarse en un id de evento: se apoya en el id del
 *    intento (nuestro `gateway_reference`) y en que el pago siga pendiente.
 *
 * Modo SIMULADO: con `ONVO_MODE=simulated` este mismo contrato responde sin salir a
 * internet, para poder recorrer el flujo de pago con tarjeta sin credenciales. La
 * decision de que modo corre vive en `core/config` (`onvoMode`), no aqui.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Currency } from '@courier/shared';
import { config, onvoMode } from '../../core/config';
import { PaymentErrors } from '../../core/errors';

/**
 * Exponente de la unidad minima de cada moneda para Onvo, que recibe los montos en
 * enteros de la subunidad: 250000 son ₡2.500,00 y 5000 son $50,00.
 *
 * OJO: esto NO es `CURRENCY_DECIMALS` de @courier/shared. Alli el colon tiene CERO
 * decimales, que es la politica de PRESENTACION del negocio (los colones no se
 * manejan con centimos). Onvo, en cambio, cuenta en centimos igual que en centavos.
 * Reusar la tabla de presentacion mandaria 2500 donde Onvo espera 250000 y cobraria
 * cien veces menos, que es justo el error que este comentario existe para evitar.
 */
const ONVO_MINOR_UNIT_EXPONENT: Record<Currency, number> = {
  [Currency.CRC]: 2,
  [Currency.USD]: 2,
};

/** Monto de dominio -> entero en la unidad minima que espera Onvo. */
export function toMinorUnit(amount: number, currency: Currency): number {
  return Math.round(amount * 10 ** ONVO_MINOR_UNIT_EXPONENT[currency]);
}

/** Datos que necesita el navegador para abrir el formulario de tarjeta. */
export interface PaymentIntent {
  /** Id del intento en Onvo. Se guarda en `payments.gateway_reference`. */
  reference: string;
  /** Lo que el SDK web recibe como `paymentIntentId`. Igual que `reference`. */
  paymentIntentId: string;
  /** Llave publicable; la web la necesita para inicializar el SDK. */
  publicKey: string;
  /** Cliente en Onvo, si el intento quedo asociado a uno. */
  customerId: string | null;
  /** True si lo produjo la pasarela simulada. La web lo usa para no cargar el SDK. */
  simulated: boolean;
}

/** Desenlace de un cobro, ya traducido a nuestro dominio. */
export interface GatewayOutcome {
  reference: string;
  approved: boolean;
  /** Motivo del rechazo, si lo hubo. */
  detail: string | null;
}

/** True si la pasarela puede cobrar hoy, de verdad o simulada. */
export function isOnvoEnabled(): boolean {
  return onvoMode !== 'off';
}

/** True si lo que hay es la pasarela de mentira. */
export function isOnvoSimulated(): boolean {
  return onvoMode === 'simulated';
}

/** Prefijo de las referencias simuladas; las distingue de un cobro real de un vistazo. */
const SIMULATED_PREFIX = 'sim_pi_';

/** Comparacion en tiempo constante; tolera longitudes distintas sin lanzar. */
function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Eventos de intento de cobro que Onvo notifica por webhook.
 *
 * `deferred` es un cobro que quedo en tramite (por ejemplo un SINPE que aun no
 * acredita). No es aprobado ni rechazado: el pago se queda PENDIENTE esperando el
 * evento definitivo, que es exactamente lo que ya hace nuestro estado inicial.
 */
const ONVO_EVENTS = {
  succeeded: 'payment-intent.succeeded',
  failed: 'payment-intent.failed',
  deferred: 'payment-intent.deferred',
} as const;

type OnvoEventBody = {
  type?: unknown;
  data?: { id?: unknown; status?: unknown; lastPaymentError?: unknown; [k: string]: unknown };
};

/** Llamada HTTP a Onvo con la llave secreta y el timeout configurado. */
async function onvoFetch(path: string, body: unknown): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ONVO_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.ONVO_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.ONVO_SECRET_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      // El cuerpo del error se registra pero no viaja al cliente: puede traer
      // detalles de la cuenta y al pagador no le sirven de nada.
      console.error(`[onvo] ${path} respondió ${res.status}: ${text.slice(0, 500)}`);
      throw PaymentErrors.gatewayError();
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[onvo] ${path} superó el timeout de ${config.ONVO_TIMEOUT_MS} ms`);
      throw PaymentErrors.gatewayError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const onvoClient = {
  /**
   * Crea el intento de cobro por `amount` en `currency`.
   *
   * Nuestro id de pago viaja como metadato para poder reconciliar a mano si algun
   * dia un webhook llega sin que la referencia haya quedado guardada.
   */
  async createPaymentIntent(params: {
    amount: number;
    currency: Currency;
    /** Nuestro id de pago; viaja como metadato para reconciliar el webhook. */
    paymentId: string;
    description: string;
  }): Promise<PaymentIntent> {
    if (!isOnvoEnabled()) throw PaymentErrors.gatewayUnavailable();

    if (isOnvoSimulated()) {
      // Un solo id para los dos campos, igual que en un cobro real: `reference` es
      // lo que guardamos y `paymentIntentId` lo que recibe el navegador, pero
      // ambos nombran el MISMO intento. Generarlos por separado haria que la
      // simulacion se comportara distinto que la pasarela de verdad.
      const id = `${SIMULATED_PREFIX}${randomUUID()}`;
      return {
        reference: id,
        paymentIntentId: id,
        publicKey: 'onvo_simulated_publishable_key',
        customerId: null,
        simulated: true,
      };
    }

    const payload = await onvoFetch('/payment-intents', {
      amount: toMinorUnit(params.amount, params.currency),
      currency: params.currency,
      description: params.description,
      metadata: { paymentId: params.paymentId },
    });

    const id = typeof payload.id === 'string' ? payload.id : null;
    if (!id) {
      console.error('[onvo] /payment-intents no devolvió un id utilizable:', payload);
      throw PaymentErrors.gatewayError();
    }

    return {
      reference: id,
      paymentIntentId: id,
      publicKey: config.ONVO_PUBLIC_KEY ?? '',
      customerId: typeof payload.customerId === 'string' ? payload.customerId : null,
      simulated: false,
    };
  },

  /**
   * Valida el header `X-Webhook-Secret` de un webhook.
   *
   * Onvo manda el secreto tal cual, no una firma del cuerpo, asi que esto es una
   * comparacion de cadenas; en tiempo constante para no filtrar el secreto a base
   * de medir cuanto tarda en fallar.
   *
   * Sin `ONVO_WEBHOOK_SECRET` configurado devuelve false SIEMPRE: preferimos
   * ignorar cobros reales a aceptar uno falso. En modo simulado tampoco se acepta
   * ningun webhook, porque la simulacion no pasa por esta ruta.
   */
  verifyWebhookSecret(received: string): boolean {
    const expected = config.ONVO_WEBHOOK_SECRET;
    if (!expected || !received) return false;
    return safeEquals(received, expected);
  },

  /**
   * Traduce el evento de Onvo a nuestro dominio. Devuelve null si el evento no nos
   * concierne (otro tipo, o uno diferido que todavia no resuelve nada).
   *
   * Solo se llama despues de que `verifyWebhookSecret` haya dado true.
   */
  parseWebhookEvent(payload: unknown): GatewayOutcome | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const { type, data } = payload as OnvoEventBody;
    if (typeof type !== 'string' || typeof data?.id !== 'string') return null;

    if (type === ONVO_EVENTS.succeeded) {
      return { reference: data.id, approved: true, detail: null };
    }
    if (type === ONVO_EVENTS.failed) {
      const error = data.lastPaymentError;
      const detail =
        typeof error === 'string'
          ? error
          : typeof (error as { message?: unknown })?.message === 'string'
            ? ((error as { message: string }).message)
            : null;
      return { reference: data.id, approved: false, detail };
    }
    // `deferred` y cualquier otro evento: el pago sigue pendiente, sin tocar nada.
    return null;
  },

  /**
   * Desenlace SIMULADO, para el flujo de prueba sin credenciales. No sale a
   * internet: fabrica el mismo `GatewayOutcome` que produciria un webhook real,
   * para que la confirmacion recorra exactamente el mismo camino.
   */
  simulateOutcome(reference: string, approved: boolean): GatewayOutcome {
    return {
      reference,
      approved,
      detail: approved ? null : 'Rechazo simulado (pasarela de pruebas).',
    };
  },

  /** True si la referencia la produjo la pasarela simulada. */
  isSimulatedReference(reference: string): boolean {
    return reference.startsWith(SIMULATED_PREFIX);
  },
};
