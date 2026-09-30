/**
 * Numero de proforma como enlace que ABRE su documento en otra pestaña.
 *
 * El numero es lo que la gente busca con la vista cuando quiere el documento,
 * asi que ahi mismo se lo abre, sin pasar por el detalle. Solo va donde el
 * componente no ofrece ya otro acceso al documento.
 *
 * `stopPropagation`: el enlace puede ir dentro de una fila o ficha que abre
 * algo al pulsarla, y abrir el documento no debe disparar eso tambien.
 */
import type { ReactNode } from 'react';
import { API_BASE } from '../lib/api';

export function ProformaLink({
  id,
  number,
  children,
}: {
  id: string;
  number: string | number;
  /** Texto del enlace; por defecto, el numero solo. */
  children?: ReactNode;
}) {
  return (
    <a
      className="proforma-link"
      href={`${API_BASE}/api/proformas/${id}/document`}
      target="_blank"
      rel="noreferrer"
      title={`Abrir la proforma ${number}`}
      onClick={(e) => e.stopPropagation()}
    >
      {children ?? number}
    </a>
  );
}
