/**
 * Pantalla "Anuncios" (permiso announcements.manage, solo admin).
 * CRUD de los banners del portal del cliente: crear, editar, activar/desactivar,
 * borrar, buscar y filtrar por tipo y estado. Fuente: docs/manuales/roles.md §3.3.
 *
 * El estado (Activo / Programado / Vencido / Inactivo) lo calcula la API a partir
 * de la vigencia; aqui no se recalcula. Las fechas llegan en UTC y se muestran en
 * la hora local del navegador.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ANNOUNCEMENT_STATUS_LABELS,
  ANNOUNCEMENT_TYPE_LABELS,
  ANNOUNCEMENT_VISIBLE_LIMIT,
  AnnouncementStatus,
  AnnouncementType,
} from '@courier/shared';
import type { AnnouncementDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { AnnouncementFormModal } from './AnnouncementFormModal';

export type AnnouncementRow = AnnouncementDto;

interface ListResponse {
  items: AnnouncementRow[];
  counts: { total: number; live: number };
}

type ModalState = { mode: 'create' } | { mode: 'edit'; row: AnnouncementRow } | null;

/** Píldora de estado: solo Activo va en verde, el resto en gris apagado. */
const STATUS_TONE: Record<AnnouncementStatus, string> = {
  [AnnouncementStatus.Activo]: 'ok',
  [AnnouncementStatus.Programado]: 'off',
  [AnnouncementStatus.Vencido]: 'off',
  [AnnouncementStatus.Inactivo]: 'off',
};

const dateFmt = new Intl.DateTimeFormat('es-CR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Instante UTC → hora local del usuario (regla de fechas del repo). */
function formatInstant(iso: string): string {
  return dateFmt.format(new Date(iso));
}

export function AnnouncementsScreen() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (type) params.set('type', type);
    if (status) params.set('status', status);
    const qs = params.toString();
    try {
      setData(await api.get<ListResponse>(`/announcements${qs ? `?${qs}` : ''}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar el listado.');
    }
  }, [q, type, status]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce de la busqueda
    return () => clearTimeout(t);
  }, [load]);

  async function toggleEnabled(row: AnnouncementRow) {
    setError(null);
    setNotice(null);
    try {
      await api.patch(`/announcements/${row.id}`, { enabled: !row.enabled });
      setNotice(`"${row.title}": ${row.enabled ? 'desactivado' : 'activado'}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cambiar el estado.');
    }
  }

  async function remove(row: AnnouncementRow) {
    if (!window.confirm(`¿Borrar el anuncio "${row.title}"? Esta acción no se puede deshacer.`)) return;
    setError(null);
    setNotice(null);
    try {
      await api.del(`/announcements/${row.id}`);
      setNotice(`Anuncio "${row.title}" borrado.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo borrar el anuncio.');
    }
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Anuncios</div>
          {data && (
            <div className="count">
              {data.counts.live} publicándose ahora · {data.counts.total} en total
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={() => setModal({ mode: 'create' })}>
          + Nuevo anuncio
        </button>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}
      {/* Con mas vigentes que el cupo, el portal recorta por severidad y recencia (§3.4.2). */}
      {data && data.counts.live > ANNOUNCEMENT_VISIBLE_LIMIT && (
        <div className="banner warn" style={{ marginBottom: 14 }}>
          Hay {data.counts.live} anuncios vigentes y el portal muestra máximo {ANNOUNCEMENT_VISIBLE_LIMIT}:
          los clientes verán los de mayor severidad y más recientes.
        </div>
      )}

      <div className="filters">
        <input
          className="input search" placeholder="Buscar por título o mensaje…"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Todos los tipos</option>
          {Object.values(AnnouncementType).map((t) => (
            <option key={t} value={t}>{ANNOUNCEMENT_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos los estados</option>
          {Object.values(AnnouncementStatus).map((s) => (
            <option key={s} value={s}>{ANNOUNCEMENT_STATUS_LABELS[s]}</option>
          ))}
        </select>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Anuncio</th>
              <th>Tipo</th>
              <th>Vigencia</th>
              <th>Estado</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="cell-name">{row.title}</div>
                  <div className="cell-sub">{row.message}</div>
                </td>
                <td>
                  <span className={`ann-tag ann-tag-${row.type}`}>{ANNOUNCEMENT_TYPE_LABELS[row.type]}</span>
                </td>
                <td>
                  <div className="cell-sub">{formatInstant(row.startsAt)}</div>
                  <div className="cell-sub">hasta {formatInstant(row.endsAt)}</div>
                </td>
                <td>
                  <span className={`spill ${STATUS_TONE[row.status]}`}>
                    <span className="dot" />
                    {ANNOUNCEMENT_STATUS_LABELS[row.status]}
                  </span>
                </td>
                <td>
                  <div className="actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setModal({ mode: 'edit', row })}>
                      Editar
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => toggleEnabled(row)}>
                      {row.enabled ? 'Desactivar' : 'Activar'}
                    </button>
                    <button className="btn btn-ghost btn-sm btn-danger-ghost" onClick={() => remove(row)}>
                      Borrar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.items.length === 0 && <div className="empty">No hay anuncios que coincidan.</div>}

      {modal && (
        <AnnouncementFormModal
          mode={modal.mode}
          row={modal.mode === 'edit' ? modal.row : undefined}
          onClose={() => setModal(null)}
          onSaved={(message) => {
            setModal(null);
            setNotice(message ?? null);
            setError(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
