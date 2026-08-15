/**
 * Descartar un paquete sin dueño — permiso control_room.manage.
 *
 * «Descartar» y no «borrar»: la fila se archiva con su motivo en vez de
 * desaparecer. El bulto estuvo físicamente en la bodega, y esa evidencia es justo
 * lo que alguien va a reclamar dentro de seis meses («el paquete llegó, ¿dónde
 * está?»). Lo que sí desaparece es de la cola de trabajo y del índice de guías
 * activas, para que un desconocido mal digitado no bloquee el alta del envío
 * legítimo que traiga esa guía.
 *
 * Se puede deshacer desde la pestaña «Descartados», y el modal lo dice: saberlo
 * es lo que evita que el motivo se escriba con miedo.
 */
import { useState } from 'react';
import { discardShipmentSchema } from '@courier/shared';
import type { ShipmentDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';

interface Props {
  row: ShipmentDto;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function DiscardPackageModal({ row, onClose, onSaved }: Props) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = discardShipmentSchema.safeParse({ reason });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
      return;
    }

    setBusy(true);
    try {
      await api.post(`/shipments/${row.id}/discard`, parsed.data);
      onSaved(`${row.code} descartado. Puedes deshacerlo desde «Descartados».`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo descartar el paquete.');
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal modal-sm fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Descartar paquete</h3>
          <p>
            {row.code} · {row.description}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}

          <div>
            <label className="field-label" htmlFor="d-reason">Motivo</label>
            <textarea
              id="d-reason"
              className="input"
              rows={3}
              maxLength={500}
              value={reason}
              placeholder="Llegó destrozado y vacío; se devolvió al operador de Miami…"
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="field-hint">Obligatorio. Queda en el historial del paquete.</div>
          </div>

          <div className="banner" style={{ background: 'var(--paper-2)', color: 'var(--muted)' }}>
            El registro no se borra: se archiva. Sale de la cola de trabajo y libera su guía, y
            puedes deshacerlo desde la pestaña «Descartados».
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Descartando…' : 'Descartar'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
