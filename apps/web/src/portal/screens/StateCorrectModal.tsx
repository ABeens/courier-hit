/**
 * Correccion administrativa del estado de un tramite (permiso shipment.correct,
 * solo admin).
 *
 * No es el hermano del avance, es su excepcion. `StateAdvanceModal` opera el
 * proceso: ofrece el paso siguiente y respeta la maquina. Este la desobedece a
 * proposito, y por eso existe aparte: mezclarlos en un solo formulario invitaria
 * a usar la correccion como atajo cuando el avance da pereza.
 *
 * Tres cosas que la pantalla deja dichas, porque son las que confunden:
 *   - No avisa al cliente (una correccion no genera correo).
 *   - No toca la factura: si los costos estaban aprobados siguen congelados.
 *   - Queda en el historial marcada como correccion, no como avance.
 */
import { useState } from 'react';
import { Condition, STATE_LABELS, conditionsFor, statesOf } from '@courier/shared';
import type { ShipmentDto, State } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';

interface Props {
  row: ShipmentDto;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function StateCorrectModal({ row, onClose, onSaved }: Props) {
  // Todos los estados del flow menos el actual: la correccion va a donde haga
  // falta, adelante o atras. La API revalida que el destino sea de esta maquina.
  const options = statesOf(row.flow).filter((s) => s !== row.state);
  const [target, setTarget] = useState<State | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Unica guarda que la correccion NO se salta (misma regla que la API): un
   * estado que le muestra al cliente un monto a pagar no puede existir sin ese
   * monto. Se comprueba aqui para avisar antes de enviar, no para decidirlo.
   */
  const missingInvoice =
    target !== '' &&
    conditionsFor(row.flow, target).includes(Condition.RequiresInvoiceAmount) &&
    row.invoiceTotalCrc == null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!target) {
      setError('Elige el estado correcto.');
      return;
    }
    if (!note.trim()) {
      setError('Indica el motivo de la corrección.');
      return;
    }
    if (missingInvoice) {
      setError(
        `«${STATE_LABELS[target]}» le muestra al cliente un monto a pagar y este trámite no tiene factura aprobada.`,
      );
      return;
    }

    setBusy(true);
    try {
      await api.post(`/shipments/${row.id}/correct-state`, {
        state: target,
        note: note.trim(),
      });
      onSaved(`Estado de ${row.code} corregido a «${STATE_LABELS[target]}».`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo corregir el estado.');
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal modal-sm fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Corregir estado</h3>
          <p>
            {row.code} · {row.client.name}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}

          <div className="banner" style={{ background: 'var(--paper-2)', color: 'var(--muted)' }}>
            Esto no es un avance: salta las reglas del flujo para enmendar un error.
            No se le notifica al cliente y la factura no se modifica.
          </div>

          <div>
            <label className="field-label">Estado actual</label>
            <div className="input" style={{ background: 'var(--paper-2)' }}>
              {STATE_LABELS[row.state]}
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="c-target">Estado correcto</label>
            <select
              id="c-target" className="input" value={target}
              onChange={(e) => setTarget(e.target.value as State)}
            >
              <option value="">Elige el estado…</option>
              {options.map((s) => (
                <option key={s} value={s}>{STATE_LABELS[s]}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="field-label" htmlFor="c-note">Motivo de la corrección</label>
            <textarea
              id="c-note" className="input" rows={3} maxLength={500} value={note}
              placeholder="Se avanzó por error al confundir el trámite con otro…"
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="field-hint">
              Obligatorio. Queda en el historial junto a la corrección, para que dentro de
              seis meses se entienda por qué el trámite retrocedió.
            </div>
          </div>

          {missingInvoice && (
            <div className="banner err">
              «{STATE_LABELS[target as State]}» le muestra al cliente un monto a pagar, y este
              trámite todavía no tiene factura aprobada. Carga y aprueba los costos primero.
            </div>
          )}

          {/* La factura es el efecto colateral que nadie espera: si el trámite ya
              se facturó, corregir el estado no lo desfactura. */}
          {row.invoiceTotalUsd != null && (
            <div className="banner" style={{ background: 'var(--paper-2)', color: 'var(--muted)' }}>
              Este trámite tiene la factura aprobada y seguirá congelada después de corregir.
              Para liberarla, usa «Reversar factura» en el editor de costos.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Corrigiendo…' : 'Corregir estado'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
