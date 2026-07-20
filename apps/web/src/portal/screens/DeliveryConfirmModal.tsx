/**
 * Modal de cierre de una visita del mensajero (Parte 5).
 *
 * Un solo componente para los dos desenlaces porque el flujo es el mismo y solo
 * cambia la PRUEBA que se exige: `proofRequirementFor` decide si pide foto o
 * comentario, con la misma regla que aplica la API. Si aqui se pidiera algo
 * distinto, el mensajero llenaria un formulario que el servidor rechaza.
 *
 * La foto se previsualiza antes de enviar: en la calle, con prisa, es facil
 * disparar una foto movida o del suelo, y descubrirlo despues de confirmar
 * significa un paquete entregado sin prueba util.
 */
import { useEffect, useState } from 'react';
import { DELIVERY_OUTCOME_LABELS, DeliveryOutcome, proofRequirementFor } from '@courier/shared';
import { API_BASE, ApiError } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';
import type { DeliveryQueueRow } from './DeliveriesScreen';

interface Props {
  row: DeliveryQueueRow;
  outcome: DeliveryOutcome;
  onClose: () => void;
  onSaved: () => void;
}

export function DeliveryConfirmModal({ row, outcome, onClose, onSaved }: Props) {
  const required = proofRequirementFor(outcome);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // La URL del objeto se revoca al cambiar de foto o cerrar: si no, cada intento
  // deja un blob retenido en memoria hasta recargar la pagina.
  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (required.photo && !photo) {
      setError('Adjunta la foto del paquete entregado.');
      return;
    }
    if (required.note && !note.trim()) {
      setError('Indica la razón de la devolución a bodega.');
      return;
    }

    /**
     * Va con `fetch` directo y no con `api.post`: el cuerpo es multipart y el
     * cliente HTTP del portal serializa a JSON. Se conserva `credentials` para
     * que viaje la cookie de sesion.
     */
    const form = new FormData();
    form.set('outcome', outcome);
    if (note.trim()) form.set('note', note.trim());
    if (photo) form.set('photo', photo);

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/deliveries/shipment/${row.id}`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(
          res.status,
          body?.error?.code ?? 'UNKNOWN',
          body?.error?.message ?? 'No se pudo registrar la entrega.',
        );
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo registrar la entrega.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal modal-sm fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>{DELIVERY_OUTCOME_LABELS[outcome]}</h3>
          <p>
            {row.code} · {row.clientName}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}

          {required.photo && (
            <div>
              <label className="field-label" htmlFor="d-photo">
                Foto del paquete entregado
              </label>
              <input
                id="d-photo"
                className="input"
                type="file"
                accept="image/*"
                // Abre la camara trasera del telefono en vez del explorador.
                capture="environment"
                onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
              />
              {preview && (
                <img
                  src={preview}
                  alt="Vista previa de la entrega"
                  style={{
                    marginTop: 12,
                    width: '100%',
                    maxHeight: 260,
                    objectFit: 'cover',
                    borderRadius: 10,
                  }}
                />
              )}
            </div>
          )}

          <div>
            <label className="field-label" htmlFor="d-note">
              {required.note ? 'Razón de la devolución' : 'Comentario (opcional)'}
            </label>
            <textarea
              id="d-note"
              className="input"
              rows={3}
              maxLength={500}
              value={note}
              placeholder={
                required.note ? 'Nadie en la dirección, se reprograma…' : 'Recibido por…'
              }
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Guardando…' : DELIVERY_OUTCOME_LABELS[outcome]}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
