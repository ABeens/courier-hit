/**
 * Formulario de tarjeta de Onvo Pay (https://docs.onvopay.com).
 *
 * La tarjeta NUNCA pasa por nuestro código: el SDK monta su propio formulario
 * dentro del contenedor y los datos viajan directo a la pasarela. Es la misma
 * razón que da forma al backend (`integrations/onvo/onvo.client.ts`): lo que nos
 * mantiene fuera del alcance de PCI.
 *
 * LO QUE ESTE COMPONENTE **NO** HACE ES CONFIRMAR EL COBRO. `onSuccess` del SDK
 * solo dice que el navegador terminó de hablar con Onvo; quien resuelve el pago
 * es el webhook contra el servidor. Por eso aquí se avisa con `onCompleted` y es
 * el llamador quien vuelve a preguntarle a NUESTRA API cómo quedó. Dar el cobro
 * por bueno con este callback anunciaría como pagado un cargo que la pasarela
 * todavía puede rechazar.
 */
import { useEffect, useRef, useState } from 'react';

/** El SDK se sirve desde Onvo; no se empaqueta ni se hospeda. */
const SDK_URL = 'https://sdk.onvopay.com/sdk.js';

interface OnvoInstance {
  render(selector: string): void;
}

interface OnvoGlobal {
  pay(options: Record<string, unknown>): OnvoInstance;
}

declare global {
  interface Window {
    onvo?: OnvoGlobal;
  }
}

/**
 * Carga del script, UNA sola vez por pestaña. El modal se abre y se cierra
 * varias veces por sesión y cada apertura volvería a inyectar la etiqueta: el
 * SDK quedaría cargado por duplicado y `window.onvo` apuntando a la última
 * copia, con la instancia anterior aún montada en un contenedor que ya no está.
 */
let sdkPromise: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Sin navegador.'));
  if (window.onvo) return Promise.resolve();
  if (!sdkPromise) {
    sdkPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        // Se olvida la promesa fallida a propósito: si el cliente perdió la red
        // un momento, el siguiente intento tiene que poder volver a pedirlo.
        sdkPromise = null;
        reject(new Error('No se pudo cargar el formulario de pago.'));
      };
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

/**
 * Id del contenedor. El SDK recibe un SELECTOR, no un nodo, así que el div
 * necesita un id propio y estable. No se usa `useId` de React porque genera
 * identificadores con dos puntos (`:r1:`), que en un selector CSS hay que
 * escapar y el SDK pasa tal cual a `querySelector`.
 */
let containerSeq = 0;

/** Mensaje para el cliente a partir del error del SDK (docs de Onvo, `details.card`). */
function describeError(data: unknown): string {
  const payload = data as
    | { message?: unknown; details?: { card?: { declineMessage?: unknown; reason?: unknown } } }
    | null
    | undefined;

  const card = payload?.details?.card;
  if (typeof card?.declineMessage === 'string' && card.declineMessage.trim()) {
    return card.declineMessage;
  }
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message;
  return 'La pasarela no pudo procesar la tarjeta. Revisa los datos e inténtalo de nuevo.';
}

interface Props {
  /** Llave publicable de Onvo. Viaja al navegador a propósito: no es un secreto. */
  publicKey: string;
  /** Intento de cobro ya creado por el servidor. */
  paymentIntentId: string;
  /** Cliente en Onvo, si el intento quedó asociado a uno. */
  customerId: string | null;
  /**
   * El SDK terminó su parte. NO significa "cobrado": el llamador debe consultar
   * el pago en nuestra API, que es donde el webhook deja el desenlace.
   */
  onCompleted: () => void;
  /** La pasarela rechazó el cargo o falló. El formulario sigue montado para reintentar. */
  onFailed: (message: string) => void;
}

export function OnvoCardForm({
  publicKey,
  paymentIntentId,
  customerId,
  onCompleted,
  onFailed,
}: Props) {
  const [containerId] = useState(() => `onvo-card-${++containerSeq}`);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * Los callbacks se leen por referencia y no entran en las dependencias del
   * efecto: el padre los redefine en cada render, y con ellos en la lista el SDK
   * se desmontaría y volvería a montarse mientras el cliente escribe la tarjeta.
   */
  const onCompletedRef = useRef(onCompleted);
  const onFailedRef = useRef(onFailed);
  onCompletedRef.current = onCompleted;
  onFailedRef.current = onFailed;

  useEffect(() => {
    let cancelled = false;

    loadSdk()
      .then(() => {
        if (cancelled) return;
        const onvo = window.onvo;
        if (!onvo) throw new Error('El formulario de pago no quedó disponible.');

        onvo
          .pay({
            publicKey,
            paymentIntentId,
            paymentType: 'one_time',
            // Solo va si el intento quedó asociado a un cliente de Onvo.
            ...(customerId ? { customerId } : {}),
            locale: 'es',
            onSuccess: () => {
              if (!cancelled) onCompletedRef.current();
            },
            onError: (data: unknown) => {
              if (!cancelled) onFailedRef.current(describeError(data));
            },
          })
          .render(`#${containerId}`);

        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'No se pudo cargar el formulario.');
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [publicKey, paymentIntentId, customerId, containerId]);

  return (
    /*
      No usa `.card-sec`: esa ficha vive en una fila de bloques separados por un
      divisor a la izquierda, y aquí ese sangrado le robaba ancho al formulario y
      le pintaba una línea vertical que no separa nada.
    */
    <div className="pay-card-form">
      <div className="card-sec-title">Pago con tarjeta</div>

      {status === 'loading' && <div className="banner">Cargando el formulario seguro…</div>}
      {status === 'error' && <div className="banner err">{loadError}</div>}

      {/*
        El contenedor se pinta SIEMPRE, también mientras carga: el SDK busca el
        selector en cuanto termina de cargar, y si el div apareciera solo con
        `status === 'ready'` no existiría todavía en ese momento.
      */}
      <div id={containerId} />
    </div>
  );
}
