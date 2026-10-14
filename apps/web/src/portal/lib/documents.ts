/**
 * Documentos de un tramite en los formularios del portal (prealerta del cliente
 * y alta del staff): que entra de lo que el usuario acaba de elegir.
 */
import { DOCUMENT_ATTACHMENT, MAX_SHIPMENT_DOCUMENTS, attachmentRejection } from '@courier/shared';

/**
 * Suma a `current` lo elegido que pase el MISMO catalogo que aplica la API, sin
 * pasar de `MAX_SHIPMENT_DOCUMENTS`. Devuelve la lista nueva y el aviso que haya
 * que mostrar (el primer rechazo, o el tope), o null si entro todo.
 */
export function mergeDocuments(current: File[], picked: File[]): { files: File[]; error: string | null } {
  let error: string | null = null;
  const accepted = picked.filter((file) => {
    const rejection = attachmentRejection(DOCUMENT_ATTACHMENT, file.type, file.name);
    if (rejection && !error) error = rejection;
    return !rejection;
  });

  const room = MAX_SHIPMENT_DOCUMENTS - current.length;
  if (accepted.length > room && !error) {
    error = `Solo puedes adjuntar ${MAX_SHIPMENT_DOCUMENTS} documentos; se tomaron los primeros.`;
  }
  return { files: [...current, ...accepted.slice(0, Math.max(room, 0))], error };
}
