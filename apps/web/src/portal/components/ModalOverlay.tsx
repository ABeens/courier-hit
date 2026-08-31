/*
  ModalOverlay — capa comun de todos los modales del portal.

  Se monta con createPortal en <body>, NO en el arbol de la pantalla: dentro de
  <section.content> el overlay quedaba atrapado en el contexto de apilamiento
  del contenido (la clase .fadeIn anima opacidad y crea uno), asi que el topbar
  sticky y el sidebar lo tapaban por mucho que se subiera su z-index.

  Cerrar con clic fuera se maneja en onMouseDown (no onClick) para que soltar el
  boton fuera del modal tras seleccionar texto dentro no lo cierre.
*/
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  onClose: () => void;
  children: ReactNode;
}

/**
 * Capas abiertas y el valor que habia antes de la primera.
 *
 * El bloqueo se cuenta porque los modales se apilan y no siempre se cierran en
 * orden: el del cobro se cierra DEBAJO de la confirmacion, que sigue abierta. Con
 * un bloqueo por modal, ese cierre devolvia el scroll al listado de fondo y la
 * pagina se movia por detras de la respuesta que el cliente esta leyendo. El
 * valor original se guarda una sola vez, al bloquear el primero, porque lo que
 * los siguientes ven ya es el `hidden` que puso el anterior.
 */
let openOverlays = 0;
let overflowBeforeFirst = '';

export function ModalOverlay({ onClose, children }: Props) {
  // Con el modal abierto la pagina de fondo no debe desplazarse.
  useEffect(() => {
    if (openOverlays === 0) overflowBeforeFirst = document.body.style.overflow;
    openOverlays += 1;
    document.body.style.overflow = 'hidden';

    return () => {
      openOverlays -= 1;
      if (openOverlays === 0) document.body.style.overflow = overflowBeforeFirst;
    };
  }, []);

  // Esc cierra, como en cualquier dialogo.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="overlay" onMouseDown={onClose} role="presentation">
      {children}
    </div>,
    document.body,
  );
}
