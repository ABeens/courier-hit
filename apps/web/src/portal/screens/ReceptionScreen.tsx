/**
 * Pantalla "Recepción" (permiso package.receive) — Requerimientos Parte 4.
 *
 * Es una mesa de bodega: el operador escanea con pistola y el cursor no debe
 * salir nunca del campo de tracking. Por eso el input se re-enfoca solo tras
 * cada registro y el formulario se envía con Enter, que es lo que la pistola
 * emite al terminar de leer un código.
 *
 * Dos desenlaces, los dos del manual:
 *   - el trámite existe  -> pasa a "Facturación en proceso";
 *   - no existe          -> se avisa para darlo de alta manualmente.
 * El segundo no se pinta como error rojo porque no lo es: es una rama esperada
 * del flujo (una compra que el cliente nunca prealertó).
 */
import { useEffect, useRef, useState } from 'react';
import { SHIPMENT_TYPE_LABELS, STATE_LABELS } from '@courier/shared';
import type { ShipmentDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { formatDateTime } from '../lib/datetime';

/** Lo registrado en esta sesión de trabajo, del más reciente al más antiguo. */
interface LogEntry {
  at: string;
  tracking: string;
  shipment: ShipmentDto | null;
  message: string;
  ok: boolean;
}

export function ReceptionScreen() {
  const [tracking, setTracking] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = tracking.trim().toUpperCase();
    if (!value || busy) return;

    setBusy(true);
    try {
      const shipment = await api.post<ShipmentDto>('/shipments/receive', { tracking: value });
      setLog((prev) => [
        {
          at: new Date().toISOString(),
          tracking: value,
          shipment,
          message: `${shipment.code} · ${shipment.client.name} → ${STATE_LABELS[shipment.state]}`,
          ok: true,
        },
        ...prev,
      ]);
    } catch (err) {
      setLog((prev) => [
        {
          at: new Date().toISOString(),
          tracking: value,
          shipment: null,
          message:
            err instanceof ApiError ? err.message : 'No se pudo registrar la recepción.',
          ok: false,
        },
        ...prev,
      ]);
    } finally {
      setTracking('');
      setBusy(false);
      // El foco vuelve al campo para que el siguiente escaneo entre solo.
      inputRef.current?.focus();
    }
  }

  const received = log.filter((entry) => entry.ok).length;

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Recepción en bodega</div>
          <div className="count">
            {received} recibidos en esta sesión · {log.length - received} sin encontrar
          </div>
        </div>
      </div>

      <form onSubmit={submit} className="filters">
        <input
          ref={inputRef}
          className="input search mono"
          placeholder="Escanea o digita el tracking…"
          value={tracking}
          autoComplete="off"
          onChange={(e) => setTracking(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Registrando…' : 'Registrar'}
        </button>
      </form>

      <div className="cards">
        {log.map((entry) => (
          <article
            className={`card-item ${entry.ok ? 'tone-ok' : 'tone-warn'}`}
            key={`${entry.at}-${entry.tracking}`}
          >
            <div className="card-item-head">
              <div className="card-item-ident">
                <div className="card-item-code mono">{entry.tracking}</div>
                <div className="card-item-title">{entry.message}</div>
                {entry.shipment && (
                  <div className="card-item-sub">
                    {SHIPMENT_TYPE_LABELS[entry.shipment.shipmentType]} ·{' '}
                    {entry.shipment.description}
                  </div>
                )}
              </div>
              <div className="card-item-aside">
                <span className="spill">
                  <span className="dot" />
                  {entry.ok ? 'Recibido' : 'Ingresar manual'}
                </span>
                <div className="card-item-sub">{formatDateTime(entry.at)}</div>
              </div>
            </div>
          </article>
        ))}
      </div>

      {log.length === 0 && (
        <div className="empty">
          Escanea el primer paquete para empezar. Los que no estén en el sistema se marcarán
          para ingresarlos a mano.
        </div>
      )}
    </div>
  );
}
