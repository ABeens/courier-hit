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

export function ModalOverlay({ onClose, children }: Props) {
  // Con el modal abierto la pagina de fondo no debe desplazarse.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
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
