/*
  Pila de avisos flotantes. Se monta una vez en la raiz del portal.

  Va con createPortal en <body> por la misma razon que ModalOverlay: dentro del
  arbol de la pantalla quedaria atrapado en su contexto de apilamiento, y tiene
  que quedar POR ENCIMA de los modales, que es donde mas se usa.
*/
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { dismissToast, getToasts, subscribeToasts, type ToastTone } from '../lib/toast';
import { Icon } from './Icon';

const ICON: Record<ToastTone, string> = { err: 'alert', ok: 'checkCircle', info: 'bell' };
const EMPTY: never[] = [];

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, () => EMPTY);
  if (typeof document === 'undefined') return null;

  return createPortal(
    // aria-live en el contenedor (siempre montado) para que el lector de
    // pantalla anuncie cada aviso nuevo. Los errores van como `alert`.
    <div className="toaster" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role={t.tone === 'err' ? 'alert' : 'status'}>
          <Icon name={ICON[t.tone]} size={18} className="toast-icon" />
          <span className="toast-msg">{t.message}</span>
          <button type="button" className="toast-close" aria-label="Cerrar aviso" onClick={() => dismissToast(t.id)}>
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
