/**
 * Pantalla "Usuarios del sistema" (permiso users.manage). Listado con busqueda +
 * filtros y conteo activos/total, crear/editar y habilitar/deshabilitar.
 * Fuente: docs/05 §3, docs/roles.md §1.3. La API revalida cada accion.
 */
import { useCallback, useEffect, useState } from 'react';
import { ROLE_LABELS, Role, UserStatus } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { StaffFormModal } from './StaffFormModal';

export interface StaffRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  status: UserStatus;
  emailVerifiedAt: string | null;
}
interface ListResponse {
  items: StaffRow[];
  counts: { total: number; active: number };
}

type ModalState = { mode: 'create' } | { mode: 'edit'; row: StaffRow } | null;

export function UsersScreen() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; link?: string } | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (role) params.set('role', role);
    if (status) params.set('status', status);
    const qs = params.toString();
    try {
      setData(await api.get<ListResponse>(`/users${qs ? `?${qs}` : ''}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar el listado.');
    }
  }, [q, role, status]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce de la busqueda
    return () => clearTimeout(t);
  }, [load]);

  async function toggleStatus(row: StaffRow) {
    const next = row.status === UserStatus.Activo ? UserStatus.Inactivo : UserStatus.Activo;
    setError(null);
    setNotice(null);
    try {
      await api.patch(`/users/${row.id}`, { status: next });
      setNotice({ text: `${row.name}: ${next === UserStatus.Activo ? 'habilitado' : 'deshabilitado'}.` });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cambiar el estado.');
    }
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Usuarios del sistema</div>
          {data && (
            <div className="count">
              {data.counts.active} activos · {data.counts.total} en total
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={() => setModal({ mode: 'create' })}>
          + Crear usuario
        </button>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && (
        <div className="banner ok" style={{ marginBottom: 14 }}>
          {notice.text}
          {notice.link && (
            <>
              {' '}
              <a href={notice.link} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', fontWeight: 700 }}>
                Abrir enlace de activación (dev)
              </a>
            </>
          )}
        </div>
      )}

      <div className="filters">
        <input
          className="input search" placeholder="Buscar por nombre o correo…"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
        <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">Todos los roles</option>
          {Object.values(Role)
            .filter((r) => r !== Role.Client)
            .map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos los estados</option>
          <option value={UserStatus.Activo}>Activo</option>
          <option value={UserStatus.Inactivo}>Inactivo</option>
        </select>
      </div>

      <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Rol</th>
            <th>Estado</th>
            <th style={{ textAlign: 'right' }}>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((row) => (
            <tr key={row.id}>
              <td>
                <div className="cell-name">{row.name}</div>
                <div className="cell-sub">{row.email}</div>
              </td>
              <td>
                <span className="role-chip">{ROLE_LABELS[row.role]}</span>
                {!row.emailVerifiedAt && (
                  <div className="cell-sub" style={{ color: 'var(--warn)' }}>Invitación pendiente</div>
                )}
              </td>
              <td>
                <span className={`spill ${row.status === UserStatus.Activo ? 'ok' : 'off'}`}>
                  <span className="dot" />
                  {row.status === UserStatus.Activo ? 'Activo' : 'Inactivo'}
                </span>
              </td>
              <td>
                <div className="actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => setModal({ mode: 'edit', row })}>
                    Editar
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => toggleStatus(row)}>
                    {row.status === UserStatus.Activo ? 'Deshabilitar' : 'Habilitar'}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {data && data.items.length === 0 && <div className="empty">No hay usuarios que coincidan.</div>}

      {modal && (
        <StaffFormModal
          mode={modal.mode}
          row={modal.mode === 'edit' ? modal.row : undefined}
          onClose={() => setModal(null)}
          onSaved={(result) => {
            setModal(null);
            setNotice(result?.message ? { text: result.message, link: result.link } : null);
            setError(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
