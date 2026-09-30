/**
 * Entrega de una PROFORMA (decisiones D4, P6 y P14 del SOW de proformas).
 *
 * El mensajero registra UNA visita: marca que paquetes de la proforma entrego,
 * cuales devolvio a bodega (con su motivo) y cuales siguen en ruta. Las fotos son
 * de la entrega, no de cada paquete: de 1 a 10, y valen para todos los paquetes
 * entregados en esta visita. Lo que siga en ruta se entrega despues, con sus
 * propias fotos.
 *
 * Se trabaja sobre la proforma completa (no sobre la pagina de la cola): se leen
 * sus paquetes que siguen "En ruta de entrega".
 */
import { useEffect, useRef, useState } from 'react';
import { MAX_DELIVERY_PHOTOS, STATE_LABELS, State, formatMoney } from '@courier/shared';
import type { ProformaDetailDto } from '@courier/shared';
import { API_BASE, ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';
import { proformaTotal } from './ProformasScreen';
import { useErrorToast } from '../lib/toast';
import { ProformaLink } from '../components/ProformaLink';

type Mark = 'entregado' | 'devuelto' | 'pendiente';

interface Props {
  proformaId: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8a2 2 0 0 1 2-2h2.5l1.2-2h6.6l1.2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </svg>
  );
}

export function ProformaDeliveryModal({ proformaId, onClose, onSaved }: Props) {
  const [data, setData] = useState<ProformaDetailDto | null>(null);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const setError = useErrorToast();
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<ProformaDetailDto>(`/proformas/${proformaId}`)
      .then((dto) => {
        setData(dto);
        // De entrada se da por entregado todo lo que va en ruta: es el caso normal.
        const initial: Record<string, Mark> = {};
        for (const s of dto.shipments) if (s.state === State.EnRutaEntrega) initial[s.id] = 'entregado';
        setMarks(initial);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'No se pudo cargar la proforma.'));
  }, [proformaId]);

  useEffect(() => {
    const urls = photos.map((photo) => URL.createObjectURL(photo));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [photos]);

  const inRoute = (data?.shipments ?? []).filter((s) => s.state === State.EnRutaEntrega);
  const others = (data?.shipments ?? []).filter((s) => s.state !== State.EnRutaEntrega);
  const delivered = inRoute.filter((s) => marks[s.id] === 'entregado');
  const returned = inRoute.filter((s) => marks[s.id] === 'devuelto');
  const room = MAX_DELIVERY_PHOTOS - photos.length;

  function addPhotos(files: FileList | null) {
    const incoming = Array.from(files ?? []);
    if (inputRef.current) inputRef.current.value = '';
    if (incoming.length === 0) return;
    setError(incoming.length > room ? `Solo puedes adjuntar ${MAX_DELIVERY_PHOTOS} fotos; se tomaron las primeras.` : null);
    setPhotos((current) => [...current, ...incoming].slice(0, MAX_DELIVERY_PHOTOS));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (delivered.length + returned.length === 0) {
      setError('Marca al menos un paquete entregado o devuelto.');
      return;
    }
    if (delivered.length > 0 && photos.length === 0) {
      setError('Adjunta al menos una foto de la entrega.');
      return;
    }
    if (returned.some((s) => !(reasons[s.id] ?? '').trim())) {
      setError('Indica por qué se devolvió cada paquete.');
      return;
    }

    const form = new FormData();
    form.set(
      'payload',
      JSON.stringify({
        delivered: delivered.map((s) => s.id),
        returned: returned.map((s) => ({ shipmentId: s.id, reason: reasons[s.id]!.trim() })),
      }),
    );
    for (const photo of photos) form.append('photo', photo);

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/deliveries/proforma/${proformaId}`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? 'No se pudo registrar la entrega.');
      }
      const pending = inRoute.length - delivered.length - returned.length;
      onSaved(
        `Proforma ${data?.number ?? ''}: ${delivered.length} entregados` +
          (returned.length > 0 ? `, ${returned.length} devueltos` : '') +
          (pending > 0 ? `, ${pending} siguen en ruta.` : '.'),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo registrar la entrega.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Entregar proforma {data?.number ? <ProformaLink id={data.id} number={data.number} /> : null}</h3>
          {data && (
            <p>
              {data.client.name} · {proformaTotal(data)}
            </p>
          )}
        </div>

        <div className="modal-body">

          {data && inRoute.length === 0 && (
            <div className="banner">Esta proforma no tiene paquetes en ruta de entrega.</div>
          )}

          {inRoute.length > 0 && (
            <div className="pay-sec">
              <div className="card-sec-title">Paquetes en ruta ({inRoute.length})</div>
              <dl className="pay-list">
                {inRoute.map((s) => (
                  <div className="card-item-field" key={s.id}>
                    <dt>
                      <strong>{s.code}</strong> · {s.hawb ?? s.tracking}
                      <div className="cell-sub">{s.description}</div>
                      {marks[s.id] === 'devuelto' && (
                        <input
                          className="input"
                          style={{ marginTop: 6 }}
                          placeholder="Motivo de la devolución"
                          aria-label={`Motivo de la devolución de ${s.code}`}
                          value={reasons[s.id] ?? ''}
                          onChange={(e) => setReasons((r) => ({ ...r, [s.id]: e.target.value }))}
                        />
                      )}
                    </dt>
                    <dd>
                      <select
                        className="input"
                        aria-label={`Resultado de ${s.code}`}
                        value={marks[s.id] ?? 'entregado'}
                        onChange={(e) => setMarks((m) => ({ ...m, [s.id]: e.target.value as Mark }))}
                      >
                        <option value="entregado">Entregado</option>
                        <option value="devuelto">Devuelto a bodega</option>
                        <option value="pendiente">Sigue en ruta</option>
                      </select>
                      <div className="cell-sub">{formatMoney(s.total, data!.currency)}</div>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Lo que NO va en esta visita, paquete por paquete y con su estado: si
              algo sigue en bodega, la proforma va a quedar entregada a medias. */}
          {others.length > 0 && (
            <div className="pay-sec">
              <div className="card-sec-title">No van en ruta ({others.length})</div>
              {others.some((s) => s.state === State.EnBodegaPendientePago) && (
                <div className="banner warn">
                  Hay paquetes de esta proforma que siguen en bodega: esta entrega quedará como parcial.
                </div>
              )}
              <dl className="pay-list">
                {others.map((s) => (
                  <div className="card-item-field" key={s.id}>
                    <dt>
                      <strong>{s.code}</strong> · {s.hawb ?? s.tracking}
                      <div className="cell-sub">{s.description}</div>
                    </dt>
                    <dd>{STATE_LABELS[s.state]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {delivered.length > 0 && (
            <div>
              <label className="field-label" htmlFor="pd-photo">Fotos de la entrega</label>
              <div className={`file-field${room === 0 ? ' is-disabled' : ''}`}>
                <input
                  id="pd-photo"
                  ref={inputRef}
                  className="file-field-input"
                  type="file"
                  accept="image/*"
                  multiple
                  capture="environment"
                  disabled={room === 0}
                  onChange={(e) => addPhotos(e.target.files)}
                />
                {room > 0 ? (
                  <label className="file-field-empty" htmlFor="pd-photo">
                    <CameraIcon />
                    <span className="file-field-cta">
                      Toma una foto o <span className="file-field-link">elígela de tu galería</span>
                    </span>
                  </label>
                ) : (
                  <div className="file-field-empty">
                    <CameraIcon />
                    <span className="file-field-cta">Ya tienes las {MAX_DELIVERY_PHOTOS} fotos. Quita una para cambiarla.</span>
                  </div>
                )}
              </div>
              <div className="field-hint">
                De 1 a {MAX_DELIVERY_PHOTOS} fotos. Valen para todos los paquetes entregados en esta visita.
              </div>
              {previews.length > 0 && (
                <div className="delivery-photos">
                  {previews.map((url, i) => (
                    <div className="delivery-photo" key={url}>
                      <img src={url} alt={`Vista previa ${i + 1} de la entrega`} />
                      <button
                        type="button"
                        className="delivery-photo-remove"
                        onClick={() => setPhotos((current) => current.filter((_, j) => j !== i))}
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
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || inRoute.length === 0}>
            {saving ? 'Guardando…' : 'Registrar entrega'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
