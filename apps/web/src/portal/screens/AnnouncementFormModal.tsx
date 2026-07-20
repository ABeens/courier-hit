/**
 * Modal crear / editar anuncio (docs/manuales/roles.md §3.3.2).
 *
 * Fechas: el formulario captura HORA LOCAL con `datetime-local` — es lo que el
 * admin piensa cuando programa "el 25 a las 8 am" — y convierte a UTC al enviar.
 * Al abrir en edicion hace el camino inverso. La hora local nunca sale de este
 * archivo: el contrato con la API es siempre ISO 8601 en UTC.
 */
import { useState } from 'react';
import { ModalOverlay } from '../components/ModalOverlay';
import {
  ANNOUNCEMENT_MESSAGE_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  ANNOUNCEMENT_TYPE_LABELS,
  AnnouncementType,
  createAnnouncementSchema,
} from '@courier/shared';
import { ApiError, api } from '../lib/api';
import type { AnnouncementRow } from './AnnouncementsScreen';

const pad = (n: number) => String(n).padStart(2, '0');

/** Instante UTC → valor de `datetime-local` en la zona del navegador. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Valor de `datetime-local` (hora local) → instante UTC en ISO 8601. */
function toUtcIso(local: string): string | null {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Ahora + `days` dias, redondeado al minuto, listo para el input. */
function defaultLocal(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setSeconds(0, 0);
  return toLocalInput(d.toISOString());
}

interface Props {
  mode: 'create' | 'edit';
  row?: AnnouncementRow;
  onClose: () => void;
  onSaved: (message?: string) => void;
}

export function AnnouncementFormModal({ mode, row, onClose, onSaved }: Props) {
  const [title, setTitle] = useState(row?.title ?? '');
  const [message, setMessage] = useState(row?.message ?? '');
  const [type, setType] = useState<AnnouncementType>(row?.type ?? AnnouncementType.Informativo);
  const [startsAt, setStartsAt] = useState(row ? toLocalInput(row.startsAt) : defaultLocal(0));
  const [endsAt, setEndsAt] = useState(row ? toLocalInput(row.endsAt) : defaultLocal(7));
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const startIso = toUtcIso(startsAt);
    const endIso = toUtcIso(endsAt);
    if (!startIso || !endIso) {
      setError('Indica la vigencia con fecha y hora válidas.');
      return;
    }

    // Se valida con el MISMO esquema que usa la API: los limites de texto y la
    // coherencia del rango no pueden diferir entre cliente y servidor.
    const parsed = createAnnouncementSchema.safeParse({
      title,
      message,
      type,
      startsAt: startIso,
      endsAt: endIso,
      enabled,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
      return;
    }

    setBusy(true);
    try {
      if (mode === 'create') {
        await api.post('/announcements', {
          title: parsed.data.title,
          message: parsed.data.message,
          type,
          startsAt: startIso,
          endsAt: endIso,
          enabled,
        });
        onSaved(`Anuncio "${parsed.data.title}" creado.`);
      } else if (row) {
        // Solo lo que cambio. Las fechas se comparan como instantes, no como
        // texto: dos representaciones distintas del mismo momento no son un cambio.
        const patch: Record<string, unknown> = {};
        if (parsed.data.title !== row.title) patch.title = parsed.data.title;
        if (parsed.data.message !== row.message) patch.message = parsed.data.message;
        if (type !== row.type) patch.type = type;
        if (startIso !== new Date(row.startsAt).toISOString()) patch.startsAt = startIso;
        if (endIso !== new Date(row.endsAt).toISOString()) patch.endsAt = endIso;
        if (enabled !== row.enabled) patch.enabled = enabled;
        if (Object.keys(patch).length === 0) {
          onSaved();
          return;
        }
        await api.patch(`/announcements/${row.id}`, patch);
        onSaved(`Anuncio "${parsed.data.title}" actualizado.`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar.');
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>{mode === 'create' ? 'Nuevo anuncio' : 'Editar anuncio'}</h3>
          <p>Se muestra como banner a todos los clientes mientras esté activo y dentro de su vigencia.</p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}

          <div>
            <label className="field-label" htmlFor="a-title">
              Título <span className="field-count">{title.length}/{ANNOUNCEMENT_TITLE_MAX}</span>
            </label>
            <input
              id="a-title" className="input" value={title} maxLength={ANNOUNCEMENT_TITLE_MAX}
              placeholder="Bodega cerrada el 25 de diciembre"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="a-message">
              Mensaje <span className="field-count">{message.length}/{ANNOUNCEMENT_MESSAGE_MAX}</span>
            </label>
            <textarea
              id="a-message" className="input" rows={3} value={message} maxLength={ANNOUNCEMENT_MESSAGE_MAX}
              placeholder="No habrá recepción de paquetes en Miami ese día. Se reanuda el 26."
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="a-type">Tipo de aviso</label>
            <select
              id="a-type" className="input" value={type}
              onChange={(e) => setType(e.target.value as AnnouncementType)}
            >
              {Object.values(AnnouncementType).map((t) => (
                <option key={t} value={t}>{ANNOUNCEMENT_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>

          <div className="field-pair">
            <div>
              <label className="field-label" htmlFor="a-from">Vigente desde</label>
              <input
                id="a-from" className="input" type="datetime-local"
                value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="a-to">Vigente hasta</label>
              <input
                id="a-to" className="input" type="datetime-local"
                value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
              />
            </div>
          </div>

          <label className="check-row">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Activo (si se desmarca, no se publica aunque esté dentro de la vigencia)
          </label>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Guardando…' : mode === 'create' ? 'Crear anuncio' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
