/**
 * Desenlace del pago, en su propia pantalla.
 *
 * Antes esto era una línea de aviso encima del listado: el modal del pago se
 * cerraba y el cliente volvía a la lista con un banner verde arriba, que es el
 * mismo sitio donde aparecen los avisos de cualquier otra cosa. Pagar es el
 * único momento del portal en el que el cliente entrega dinero, y merece una
 * respuesta que ocupe la pantalla y que haya que cerrar a propósito.
 *
 * Es también la pantalla de la ESPERA: aparece con un loader en cuanto el cargo
 * sale hacia la pasarela y se transforma en el desenlace cuando llega, sin
 * desmontarse. El cliente ve una sola ventana que cambia, no una que se cierra y
 * otra que se abre, que es lo que hace que la respuesta se lea como la respuesta
 * a lo que acaba de hacer.
 *
 * LO QUE DECIDE ESTA PANTALLA ES EL TONO, y por eso el resultado no es un texto
 * sino un `kind`. Un cobro con tarjeta aprobado es dinero recibido; un depósito
 * registrado y un cobro a la espera del webhook NO lo son. Con un solo diseño
 * verde para los tres, al que subió un comprobante se le estaría diciendo que ya
 * pagó, que es justo lo que hace que nadie vuelva a mirar si el pago se validó.
 */
import { Icon } from '../components/Icon';
import { ModalOverlay } from '../components/ModalOverlay';

export interface PaymentResult {
  /**
   * `processing`: el cargo salió y estamos esperando el desenlace de la pasarela.
   * `paid`: el dinero ya entró. `pending`: va en camino y falta que alguien lo
   * resuelva (un depósito por validar, o un cobro cuyo webhook no llegó a tiempo).
   */
  kind: 'processing' | 'paid' | 'pending';
  title: string;
  message: string;
  /** Trámite e importe de los que se habla: los del pago que se acaba de hacer. */
  code: string;
  amount: string;
}

export function PaymentResultModal({
  result,
  onClose,
}: {
  result: PaymentResult;
  onClose: () => void;
}) {
  const paid = result.kind === 'paid';
  const working = result.kind === 'processing';

  return (
    /*
      Mientras se confirma no hay nada que cerrar: el cobro ya salió y la ventana
      es el único sitio donde el cliente ve en qué quedó. Cerrarla no cancelaría
      nada, solo le escondería la respuesta.
    */
    <ModalOverlay onClose={working ? () => undefined : onClose}>
      <div
        className={`modal modal-sm pay-result fadeUp${paid ? ' is-paid' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={result.title}
      >
        <div className="modal-body">
          {/*
            `key` por situación: la marca se vuelve a montar al pasar de la espera
            al desenlace, y con ella su animación. Sin eso, el círculo se quedaría
            quieto y el cambio de spinner a visto bueno pasaría desapercibido, que
            es justo el momento que el cliente está esperando.
          */}
          <div className="pay-result-mark" key={result.kind}>
            {working ? (
              <span className="pay-result-spinner" aria-hidden="true" />
            ) : (
              <Icon name={paid ? 'check' : 'clock'} size={30} strokeWidth={2.6} />
            )}
          </div>

          <h3>{result.title}</h3>
          <p className="pay-result-amount">{result.amount}</p>
          <p className="pay-result-code">{result.code}</p>
          <p className="pay-result-text">{result.message}</p>
        </div>

        {/* Sin desenlace no hay nada que pulsar: el pie aparece con la respuesta. */}
        {!working && (
          <div className="modal-foot">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Listo
            </button>
          </div>
        )}
      </div>
    </ModalOverlay>
  );
}
