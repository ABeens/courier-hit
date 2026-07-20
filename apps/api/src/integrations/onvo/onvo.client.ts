/**
 * Pasarela de pago: Onvo Pay (Costa Rica).
 *
 * Estructura lista, integracion pendiente. El modulo de pagos ya habla con este
 * contrato, asi que conectar la pasarela de verdad es rellenar los tres huecos de
 * abajo — ningun servicio ni pantalla cambia.
 *
 * TODO(09/onvo): implementar contra la API de Onvo Pay:
 *   1. `createPaymentIntent` — crear el intento de cobro y devolver el
 *      `clientSecret`/URL con el que el navegador abre el formulario de tarjeta.
 *      Onvo expone el checkout del lado del cliente: la tarjeta NUNCA toca
 *      nuestro backend, que es justo lo que nos mantiene fuera del alcance de PCI.
 *   2. `verifyWebhookSignature` — validar la firma de cada webhook con
 *      ONVO_WEBHOOK_SECRET. Sin esto cualquiera podria marcar un pago como
 *      confirmado con un POST.
 *   3. `parseWebhookEvent` — traducir el evento de Onvo a nuestro dominio
 *      (referencia del pago + si quedo aprobado o rechazado).
 *
 * Mientras `onvoReady` sea false el modulo de pagos no ofrece tarjeta y el
 * cliente paga por deposito bancario, que es un flujo completo y sin terceros.
 */
import { config, onvoReady } from '../../core/config';
import { PaymentErrors } from '../../core/errors';

/** Datos que necesita el navegador para abrir el formulario de tarjeta. */
export interface PaymentIntent {
  /** Referencia del cobro en Onvo. Se guarda en `payments.gateway_reference`. */
  reference: string;
  /** Secreto de un solo uso con el que el SDK del navegador monta el formulario. */
  clientSecret: string;
  /** Llave publicable de la cuenta; la web la necesita para inicializar el SDK. */
  publicKey: string;
}

/** Desenlace de un cobro, ya traducido a nuestro dominio. */
export interface GatewayOutcome {
  reference: string;
  approved: boolean;
  /** Motivo del rechazo, si lo hubo. */
  detail: string | null;
}

/** True si la pasarela esta encendida Y con credenciales (ver `onvoReady`). */
export function isOnvoEnabled(): boolean {
  return onvoReady;
}

export const onvoClient = {
  /**
   * Crea el intento de cobro por `amount` en `currency`.
   *
   * TODO(09/onvo): POST {ONVO_BASE_URL}/payment-intents con la llave secreta en
   * Authorization. El monto viaja en la unidad minima de la moneda (centavos /
   * centimos), asi que hay que multiplicar segun CURRENCY_DECIMALS antes de
   * enviarlo — mandar 15.5 donde esperan 1550 cobraria cien veces menos.
   */
  async createPaymentIntent(_params: {
    amount: number;
    currency: string;
    /** Nuestro id de pago; viaja como metadato para reconciliar el webhook. */
    paymentId: string;
    description: string;
  }): Promise<PaymentIntent> {
    if (!isOnvoEnabled()) throw PaymentErrors.gatewayUnavailable();
    void config.ONVO_BASE_URL;
    throw PaymentErrors.gatewayUnavailable();
  },

  /**
   * Valida la firma del webhook.
   *
   * TODO(09/onvo): HMAC del cuerpo CRUDO con ONVO_WEBHOOK_SECRET, comparado en
   * tiempo constante. Devuelve false por defecto a proposito: mientras no este
   * implementado, ningun webhook se acepta. Un stub que devolviera true dejaria
   * la confirmacion de pagos abierta a cualquiera.
   */
  verifyWebhookSignature(_rawBody: string, _signature: string): boolean {
    return false;
  },

  /**
   * Traduce el evento de Onvo a nuestro dominio.
   *
   * TODO(09/onvo): mapear los eventos de cobro aprobado/rechazado. Solo se llama
   * despues de que `verifyWebhookSignature` haya dado true.
   */
  parseWebhookEvent(_payload: unknown): GatewayOutcome | null {
    return null;
  },
};
