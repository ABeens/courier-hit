/**
 * Corrección manual del enlace de un casillero con el operador de Miami
 * (permiso config.manage, solo Admin).
 *
 * Esta pantalla NO llama al operador: existe justo para cuando el operador no
 * coopera. El flujo real es al revés — alguien crea el destinatario a mano en la
 * interfaz del proveedor y aquí solo refleja el resultado. Por eso el formulario
 * pide datos que hay que ir a buscar allá (el id y el sub-casillero) en vez de
 * ofrecer un botón de "reintentar", que es lo que ya hace el robot solo.
 *
 * El motivo es obligatorio: una corrección manual sin explicación deja a la
 * siguiente persona sin saber si el enlace es de fiar.
 */
import { useState } from 'react';
import { HELGA_SYNC_STATUS_LABELS, HelgaSyncStatus } from '@courier/shared';
import type { ProviderLinkDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';

interface Props {
  row: ProviderLinkDto;
  onClose: () => void;
  onSaved: (message: string) => void;
}

/** `''` en un campo de texto significa "no tocar"; el usuario borra con el check. */
export function ProviderLinkEditModal({ row, onClose, onSaved }: Props) {
  const [status, setStatus] = useState<HelgaSyncStatus>(row.status);
  const [helgaClientId, setHelgaClientId] = useState(row.helgaClientId ?? '');
  const [subLocker, setSubLocker] = useState(row.subLocker ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Solo viaja lo que cambió. Mandar todo haría que la bitácora registrara
    // como "corrección" campos que nadie tocó.
    const patch: Record<string, unknown> = { note: note.trim() };
    if (status !== row.status) patch.status = status;

    const nextId = helgaClientId.trim();
    if (nextId !== (row.helgaClientId ?? '')) patch.helgaClientId = nextId === '' ? null : nextId;

    const nextLocker = subLocker.trim();
    if (nextLocker !== (row.subLocker ?? '')) patch.subLocker = nextLocker === '' ? null : nextLocker;

    if (patch.status === undefined && patch.helgaClientId === undefined && patch.subLocker === undefined) {
      setError('No cambiaste ningún dato del enlace.');
      return;
    }

    setSaving(true);
    try {
      await api.patch(`/clients/${row.clientId}/provider-link`, patch);
      onSaved(`Enlace de ${row.clientCode} actualizado.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo actualizar el enlace.');
      setSaving(false);
    }
  }

  const markingSynced = status === HelgaSyncStatus.Synced && row.status !== HelgaSyncStatus.Synced;

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Corregir el enlace</h3>
          <p>
            {row.clientCode} · {row.name}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}

          {row.lastError && (
            <div className="banner" style={{ marginBottom: 14 }}>
              <strong>Último rechazo del operador:</strong> {row.lastError}
            </div>
          )}

          <div>
            <label className="field-label" htmlFor="pl-status">Estado del enlace</label>
            <select
              id="pl-status"
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as HelgaSyncStatus)}
            >
              {Object.values(HelgaSyncStatus).map((s) => (
                <option key={s} value={s}>
                  {HELGA_SYNC_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          <div className="field-pair">
            <div>
              <label className="field-label" htmlFor="pl-id">Id de destinatario en el operador</label>
              <input
                id="pl-id"
                className="input"
                inputMode="numeric"
                placeholder="p. ej. 13939"
                value={helgaClientId}
                onChange={(e) => setHelgaClientId(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="pl-locker">Sub-casillero</label>
              <input
                id="pl-locker"
                className="input"
                placeholder="p. ej. SJO008835S033"
                value={subLocker}
                onChange={(e) => setSubLocker(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="pl-note">Motivo de la corrección</label>
            <input
              id="pl-note"
              className="input"
              placeholder="Por qué se corrige a mano"
              value={note}
              maxLength={300}
              required
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {markingSynced && (
            <div className="banner warn" style={{ marginTop: 4 }}>
              Al marcarlo como <strong>enlazado</strong>, el cliente podrá ingresar al
              portal. Confirma que el destinatario existe de verdad en el operador: si
              no, sus paquetes llegarán a Miami sin dueño.
            </div>
          )}

          <div className="banner" style={{ marginTop: 4 }}>
            El sub-casillero es la dirección con la que el cliente recibe en Miami.
            Escribirlo mal manda sus compras a una cuenta sin dueño.
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar corrección'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
