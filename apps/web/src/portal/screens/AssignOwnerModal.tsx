/**
 * Asignar (o cambiar) el dueño de un trámite — permiso control_room.manage.
 *
 * UN modal para los dos casos, porque para el usuario son la misma pregunta
 * («¿de quién es esta caja?») y para la API la misma operación:
 *
 *   - ASIGNAR   -> el paquete llegó a bodega sin dueño y ya se identificó.
 *   - REASIGNAR -> estaba cargado al casillero equivocado (homónimos, dos cuentas
 *                  de la misma familia, un dedazo en el alta).
 *
 * Lo que cambia entre uno y otro es el texto y las advertencias: reasignar le
 * quita el paquete a alguien que hoy lo ve en su portal, y eso hay que decirlo
 * antes de pulsar, no después.
 */
import { useCallback, useEffect, useState } from 'react';
import { assignShipmentOwnerSchema, clientFullLabel } from '@courier/shared';
import type { Page, ShipmentDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';

interface ClientOption {
  id: string;
  code: string;
  name: string;
  idNumber: string;
}

/**
 * Cuántos casilleros se ofrecen en el desplegable.
 *
 * Antes se pedían TODOS y se pintaba un `<option>` por casillero: con unos pocos
 * miles, el desplegable es inservible (nadie encuentra a nadie desplazándose) y
 * el modal tarda en abrir. El buscador de arriba es el que resuelve, y este tope
 * es lo que queda a la vista mientras se escribe. Si sobran, se dice.
 */
const CLIENT_OPTIONS = 50;

interface Props {
  row: ShipmentDto;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function AssignOwnerModal({ row, onClose, onSaved }: Props) {
  const isReassignment = row.client !== null;
  const [clientId, setClientId] = useState('');
  const [clientQuery, setClientQuery] = useState('');
  const [clients, setClients] = useState<ClientOption[]>([]);
  /** Cuántos casilleros hay en total con esa búsqueda, para avisar si sobran. */
  const [clientMatches, setClientMatches] = useState(0);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadClients = useCallback(async () => {
    const params = new URLSearchParams({ pageSize: String(CLIENT_OPTIONS) });
    if (clientQuery.trim()) params.set('q', clientQuery.trim());
    try {
      const res = await api.get<Page<ClientOption>>(`/clients?${params.toString()}`);
      setClients(res.items);
      setClientMatches(res.total);
    } catch {
      // el error se verá al enviar; no bloqueamos el formulario
      setClients([]);
      setClientMatches(0);
    }
  }, [clientQuery]);

  useEffect(() => {
    const t = setTimeout(loadClients, 250); // debounce de la búsqueda
    return () => clearTimeout(t);
  }, [loadClients]);

  /**
   * Los dos candados de dinero de la API, comprobados también aquí para avisar
   * antes de enviar en vez de después: cambiar de dueño con la factura congelada
   * o con abonos registrados movería una deuda entre dos clientes.
   */
  const invoiceFrozen = isReassignment && row.invoiceTotalUsd !== null;
  const hasPayments = isReassignment && (row.settledCrc > 0 || row.pendingCrc > 0);
  const locked = invoiceFrozen || hasPayments;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = assignShipmentOwnerSchema.safeParse({ clientId, note });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
      return;
    }

    setBusy(true);
    try {
      const saved = await api.post<ShipmentDto>(`/shipments/${row.id}/assign`, parsed.data);
      onSaved(
        isReassignment
          ? `${row.code} pasó a ${clientFullLabel(saved.client)}.`
          : `${row.code} quedó asignado a ${clientFullLabel(saved.client)}.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cambiar el dueño.');
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal modal-sm fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>{isReassignment ? 'Cambiar de dueño' : 'Asignar dueño'}</h3>
          <p>
            {row.code} · {row.description}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}

          {invoiceFrozen && (
            <div className="banner err">
              Este trámite ya tiene la factura aprobada. Cambiarle el dueño movería la deuda de
              un cliente a otro: reversa los costos desde el editor de costos y vuelve aquí.
            </div>
          )}
          {hasPayments && !invoiceFrozen && (
            <div className="banner err">
              Este trámite tiene pagos registrados a nombre del cliente actual. Resuélvelos antes
              de cambiarle el dueño.
            </div>
          )}

          <div>
            <label className="field-label">Dueño actual</label>
            <div className="input" style={{ background: 'var(--paper-2)' }}>
              {clientFullLabel(row.client)}
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="a-client">
              {isReassignment ? 'Nuevo dueño' : 'Dueño'}
            </label>
            <input
              className="input"
              placeholder="Buscar por nombre, casillero o cédula…"
              value={clientQuery}
              onChange={(e) => setClientQuery(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <select
              id="a-client"
              className="input"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              disabled={locked}
            >
              <option value="">Elige un cliente…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name} ({c.idNumber})
                </option>
              ))}
            </select>
            {/* El desplegable está recortado y hay que decirlo: quien no ve a su
                cliente ahí tiene que saber que no es que no exista, sino que hay
                más de los que caben. */}
            {clientMatches > clients.length && (
              <div className="field-hint">
                {clients.length} de {clientMatches.toLocaleString('es-CR')} casilleros. Afina la
                búsqueda para ver el resto.
              </div>
            )}
          </div>

          <div>
            <label className="field-label" htmlFor="a-note">
              {isReassignment ? 'Motivo del cambio' : 'Cómo se identificó al dueño'}
            </label>
            <textarea
              id="a-note"
              className="input"
              rows={3}
              maxLength={500}
              value={note}
              disabled={locked}
              placeholder={
                isReassignment
                  ? 'Se cargó al casillero equivocado: hay dos clientes con el mismo nombre…'
                  : 'La factura dentro de la caja va a nombre del titular; confirmado por teléfono…'
              }
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="field-hint">
              Obligatorio. Queda en el historial del trámite, y el cliente no lo ve.
            </div>
          </div>

          <div className="banner" style={{ background: 'var(--paper-2)', color: 'var(--muted)' }}>
            {isReassignment
              ? 'El paquete desaparece del portal del cliente actual y aparece en el del nuevo. No se le notifica a ninguno de los dos: es una corrección, no un avance.'
              : 'El paquete entra al portal del cliente y ya puede seguir el flujo normal: costos, factura, cobro y entrega. No se le manda correo por esto.'}
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || locked}>
            {busy ? 'Guardando…' : isReassignment ? 'Cambiar dueño' : 'Asignar dueño'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
