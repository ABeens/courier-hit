/**
 * Modal crear / editar staff. En crear: valida con el esquema compartido y
 * dispara la invitacion (el admin nunca fija la clave, docs/roles.md §1.3.4).
 * En editar: envia solo los campos cambiados. El correo es el login: fijo al editar.
 */
import { useState } from 'react';
import { ROLE_LABELS, Role, STAFF_ROLES, createStaffSchema } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import type { StaffRow } from './UsersScreen';

export interface SavedResult {
  message?: string;
  /** Enlace de activacion (solo en dev; en prod lo lleva el correo). */
  link?: string;
}

interface Props {
  mode: 'create' | 'edit';
  row?: StaffRow;
  onClose: () => void;
  onSaved: (result?: SavedResult) => void;
}

export function StaffFormModal({ mode, row, onClose, onSaved }: Props) {
  const [name, setName] = useState(row?.name ?? '');
  const [email, setEmail] = useState(row?.email ?? '');
  const [phone, setPhone] = useState(row?.phone ?? '');
  const [role, setRole] = useState<Role>(row?.role ?? Role.Operativo);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'create') {
        const parsed = createStaffSchema.safeParse({
          name,
          email,
          phone: phone.trim() || undefined,
          role,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
          setBusy(false);
          return;
        }
        const res = await api.post<{ inviteLink?: string }>('/users', parsed.data);
        onSaved({
          message: `Usuario creado. Se envió una invitación a ${parsed.data.email} para fijar su contraseña.`,
          link: res.inviteLink,
        });
      } else if (row) {
        // Solo enviamos lo que cambio (el correo no se edita).
        const patch: Record<string, unknown> = {};
        if (name !== row.name) patch.name = name.trim();
        if ((phone.trim() || null) !== row.phone) patch.phone = phone.trim() || null;
        if (role !== row.role) patch.role = role;
        if (Object.keys(patch).length === 0) {
          onSaved();
          return;
        }
        await api.patch(`/users/${row.id}`, patch);
        onSaved({ message: `Usuario ${name} actualizado.` });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar.');
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>{mode === 'create' ? 'Crear usuario' : 'Editar usuario'}</h3>
          <p>
            {mode === 'create'
              ? 'Se enviará una invitación por correo para que fije su contraseña.'
              : 'El correo es el usuario de acceso y no se puede cambiar aquí.'}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}

          <div>
            <label className="field-label" htmlFor="f-name">Nombre completo</label>
            <input id="f-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <label className="field-label" htmlFor="f-email">Correo electrónico</label>
            <input
              id="f-email" className="input" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)} disabled={mode === 'edit'}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="f-phone">Teléfono (opcional)</label>
            <input id="f-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>

          <div>
            <label className="field-label" htmlFor="f-role">Rol</label>
            <select id="f-role" className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {STAFF_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Guardando…' : mode === 'create' ? 'Crear usuario' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </div>
  );
}
