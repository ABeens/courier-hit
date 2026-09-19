/**
 * Modal de cierre de una visita del mensajero (Parte 5).
 *
 * Un solo componente para los dos desenlaces porque el flujo es el mismo y solo
 * cambia la PRUEBA que se exige: `proofRequirementFor` decide si pide foto o
 * comentario, con la misma regla que aplica la API. Si aqui se pidiera algo
 * distinto, el mensajero llenaria un formulario que el servidor rechaza.
 *
 * Las fotos se ACUMULAN, hasta `MAX_DELIVERY_PHOTOS`: en el telefono, con
 * `capture`, cada toque de la camara devuelve una sola foto, asi que la unica
 * forma de subir tres angulos (la caja, la fachada, quien recibe) es que cada
 * disparo se sume a los anteriores en vez de reemplazarlos.
 *
 * Todas se previsualizan antes de enviar y se pueden quitar una a una: en la
 * calle, con prisa, es facil disparar una foto movida o del suelo, y descubrirlo
 * despues de confirmar significa un paquete entregado sin prueba util.
 */
import { useEffect, useRef, useState } from 'react';
import {
  DELIVERY_OUTCOME_LABELS,
  DeliveryOutcome,
  MAX_DELIVERY_PHOTOS,
  proofRequirementFor,
} from '@courier/shared';
import { API_BASE, ApiError } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';
import type { DeliveryQueueRow } from './DeliveriesScreen';

interface Props {
  row: DeliveryQueueRow;
  outcome: DeliveryOutcome;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Camara y no la flecha de subir de `FileField`: en el 99% de las visitas la
 * foto se acaba de tomar con el telefono, no se busca en un disco.
 */
function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8a2 2 0 0 1 2-2h2.5l1.2-2h6.6l1.2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </svg>
  );
}

export function DeliveryConfirmModal({ row, outcome, onClose, onSaved }: Props) {
  const required = proofRequirementFor(outcome);
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Las urls de objeto se revocan al cambiar la lista o al cerrar: si no, cada
   * disparo deja un blob retenido en memoria hasta recargar la pagina. Se
   * recalculan todas juntas porque son la vista de un unico estado (la lista de
   * fotos), y llevar la cuenta de cual se creo cuando solo abriria la puerta a
   * revocar una que sigue pintada.
   */
  useEffect(() => {
    const urls = photos.map((photo) => URL.createObjectURL(photo));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [photos]);

  const room = MAX_DELIVERY_PHOTOS - photos.length;

  /**
   * Suma lo que venga del selector a lo que ya habia, sin pasar del tope. El
   * input se vacia despues a proposito: sin eso, volver a elegir el MISMO
   * archivo (o disparar otra vez la camara) no emite `change` y el campo parece
   * roto.
   */
  function addPhotos(files: FileList | null) {
    const incoming = Array.from(files ?? []);
    if (inputRef.current) inputRef.current.value = '';
    if (incoming.length === 0) return;

    if (incoming.length > room) {
      setError(`Solo puedes adjuntar ${MAX_DELIVERY_PHOTOS} fotos; se tomaron las primeras.`);
    } else {
      setError(null);
    }
    setPhotos((current) => [...current, ...incoming].slice(0, MAX_DELIVERY_PHOTOS));
  }

  function removePhoto(index: number) {
    setPhotos((current) => current.filter((_, i) => i !== index));
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (required.photo && photos.length === 0) {
      setError('Adjunta al menos una foto del paquete entregado.');
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
     *
     * Las fotos van con `append` y el MISMO nombre de campo: es como se manda una
     * lista en multipart, y es lo que la API lee con `parseBody({ all: true })`.
     */
    const form = new FormData();
    form.set('outcome', outcome);
    if (note.trim()) form.set('note', note.trim());
    for (const photo of photos) form.append('photo', photo);

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
                Fotos del paquete entregado
              </label>

              {/*
                Misma caja que el resto de adjuntos del portal (`.file-field`):
                el input nativo se oculta sin sacarlo del formulario ni del
                teclado, y lo que se ve es la zona clicable. No se reusa el
                componente `FileField` porque aquel es de UN archivo y pinta su
                ficha con nombre y tamaño; aqui son hasta tres fotos y lo que
                importa es verlas, no leer como se llaman.

                `multiple` para quien lo abra desde la galeria, y `capture` para
                que en el telefono salte la camara trasera.
              */}
              <div
                className={`file-field${room === 0 ? ' is-disabled' : ''}${dragging ? ' is-drag' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (room > 0) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  if (room > 0) addPhotos(e.dataTransfer.files);
                }}
              >
                <input
                  id="d-photo"
                  ref={inputRef}
                  className="file-field-input"
                  type="file"
                  accept="image/*"
                  multiple
                  capture="environment"
                  disabled={room === 0}
                  onChange={(e) => addPhotos(e.target.files)}
                />

                {/*
                  Con el cupo lleno deja de ser un `label`: un selector que no
                  hace nada al pulsarlo es peor que uno que explica por que. La
                  caja se queda en su sitio para que la ventana no pegue un salto
                  al llegar a la tercera foto.
                */}
                {room > 0 ? (
                  <label className="file-field-empty" htmlFor="d-photo">
                    <CameraIcon />
                    <span className="file-field-cta">
                      Toma una foto o <span className="file-field-link">elígela de tu galería</span>
                    </span>
                  </label>
                ) : (
                  <div className="file-field-empty">
                    <CameraIcon />
                    <span className="file-field-cta">
                      Ya tienes las {MAX_DELIVERY_PHOTOS} fotos. Quita una para cambiarla.
                    </span>
                  </div>
                )}
              </div>

              <div className="field-hint">
                Al menos una, hasta {MAX_DELIVERY_PHOTOS}. Cada toma se suma a las anteriores.
              </div>

              {previews.length > 0 && (
                <div className="delivery-photos">
                  {previews.map((url, i) => (
                    <div className="delivery-photo" key={url}>
                      <img src={url} alt={`Vista previa ${i + 1} de la entrega`} />
                      <button
                        type="button"
                        className="delivery-photo-remove"
                        onClick={() => removePhoto(i)}
                        aria-label={`Quitar la foto ${i + 1}`}
                        title="Quitar esta foto"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden="true">
                          <path d="M6 6l12 12M18 6 6 18" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
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
