/**
 * Avance manual de estado de un tramite (docs/manuales/flujo.md L37, L84).
 *
 * Aplica a los TRES flujos, no solo a los manuales. La linea no es el tipo de
 * tramite sino QUIEN reporta el hecho: todo estado que no mueva el proveedor lo
 * tiene que poder empujar la operacion. En Transporte y Agenciamiento eso es el
 * flujo entero (no hay bodega de Miami ni sincronizacion); en Paqueteria es el
 * tramo de facturacion en adelante, que hasta ahora solo avanzaba como efecto
 * colateral de otra pantalla (recepcion, costos, rutas) y no tenia forma directa.
 *
 * No decide ninguna regla: los destinos salen de `nextStates`, la frontera del
 * proveedor de `isProviderDrivenState`, el permiso de `permissionFor` y las
 * guardas de datos de `conditionsFor`, la misma fuente que aplica
 * `transitionsService` en la API. Aqui solo se muestran antes de enviar, para no
 * ofrecer un avance que el servidor va a rechazar.
 */
import { useMemo, useState } from 'react';
import {
  CONDITION_LABELS,
  Condition,
  STATE_LABELS,
  can,
  conditionsFor,
  isProviderDrivenState,
  nextStates,
  permissionFor,
  unmetConditions,
} from '@courier/shared';
import type { Role, ShipmentDto, State } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';

interface Props {
  row: ShipmentDto;
  role: Role;
  onClose: () => void;
  onSaved: (message: string) => void;
}

/**
 * Estados a los que este rol puede llevar el tramite a mano: los legales en la
 * maquina, menos los que reporta el proveedor, filtrados por el permiso que cada
 * step declara.
 *
 * Los dos filtros descartan por razones distintas y conviene no confundirlas:
 *   - PERMISO: el rol no puede hacerlo. La API lo rechazaria con un 403.
 *   - PROVEEDOR: nadie deberia hacerlo a mano. La API si lo aceptaria, y por eso
 *     el filtro importa: empujar "Recibido bodega Miami" desde el panel seria
 *     inventar un hecho fisico que Helga va a reportar sola, y dejaria el tramite
 *     adelantado respecto de la guia real.
 */
export function reachableStates(row: ShipmentDto, role: Role): State[] {
  return nextStates(row.flow, row.state).filter((to) => {
    if (isProviderDrivenState(row.flow, to)) return false;
    const permission = permissionFor(row.flow, to);
    return permission != null && can(role, permission);
  });
}

export function StateAdvanceModal({ row, role, onClose, onSaved }: Props) {
  const targets = useMemo(() => reachableStates(row, role), [row, role]);
  const [target, setTarget] = useState<State | ''>(targets[0] ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Sin destinos, el motivo cambia el mensaje: que el proveedor lleve este tramo
   * no es lo mismo que no tener permiso. Decir «con tu rol» cuando el paquete
   * simplemente esta esperando a Helga manda a pedir un permiso que no falta.
   */
  const waitingOnProvider =
    targets.length === 0 &&
    nextStates(row.flow, row.state).some((to) => isProviderDrivenState(row.flow, to));

  /**
   * Guardas del estado destino, y cuales de ellas NO se cumplen todavia. Se
   * evaluan antes de enviar para que el aviso llegue como advertencia y no como
   * error del servidor, y para no dejar pulsar un avance que la API va a
   * rechazar: sin factura aprobada no se entra a «Pendiente pago», y sin el saldo
   * cubierto el paquete no sale a ruta por mucho que la maquina permita el paso.
   */
  const conditions = target ? conditionsFor(row.flow, target) : [];
  const unmet = target ? unmetConditions(row.flow, target, row) : [];
  const needsNote = conditions.includes(Condition.RequiresComment);
  const blocked = unmet.length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!target || blocked) return;
    if (needsNote && !note.trim()) {
      setError('Este estado exige un comentario con la razón.');
      return;
    }

    setBusy(true);
    try {
      await api.post(`/shipments/${row.id}/transition`, {
        state: target,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onSaved(`Trámite ${row.code} avanzó a «${STATE_LABELS[target]}».`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo avanzar el trámite.');
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal modal-sm fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Avanzar trámite</h3>
          <p>
            {row.code} · {row.client.name}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}

          <div>
            <label className="field-label">Estado actual</label>
            <div className="input" style={{ background: 'var(--paper-2)' }}>
              {STATE_LABELS[row.state]}
            </div>
          </div>

          {targets.length === 0 ? (
            <div className="banner" style={{ background: 'var(--paper-2)', color: 'var(--muted)' }}>
              {waitingOnProvider
                ? `Este tramo lo reporta el proveedor: el paquete avanza solo desde «${STATE_LABELS[row.state]}» cuando cambie su guía. No se empuja a mano.`
                : `No hay avance disponible desde «${STATE_LABELS[row.state]}» con tu rol.`}
            </div>
          ) : (
            <div>
              <label className="field-label" htmlFor="s-target">Avanzar a</label>
              {/* Con un solo destino no hay nada que elegir: se muestra fijo para
                  que el administrador confirme, no para que decida. */}
              {targets.length === 1 ? (
                <div className="input" style={{ background: 'var(--paper-2)' }}>
                  {STATE_LABELS[targets[0]!]}
                </div>
              ) : (
                <select
                  id="s-target" className="input" value={target}
                  onChange={(e) => setTarget(e.target.value as State)}
                >
                  {targets.map((s) => (
                    <option key={s} value={s}>{STATE_LABELS[s]}</option>
                  ))}
                </select>
              )}
              <div className="field-hint">
                El avance es paso a paso y no se puede deshacer: la máquina de estados no admite
                retroceder ni saltar etapas.
              </div>
            </div>
          )}

          {/* Un mismo bloque para las dos lecturas: en gris es el recordatorio de
              lo que pide el estado, en rojo es el motivo por el que el avance no
              se puede ejecutar. Cada requisito dice si falta, para que el
              operador sepa qué resolver y dónde. */}
          {conditions.length > 0 && (
            <div
              className={blocked ? 'banner err' : 'banner'}
              style={blocked ? undefined : { background: 'var(--paper-2)', color: 'var(--muted)' }}
            >
              {blocked
                ? `Todavía no se puede avanzar a «${STATE_LABELS[target as State]}»:`
                : `Para entrar a «${STATE_LABELS[target as State]}»:`}
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {conditions.map((c) => (
                  <li key={c}>
                    {CONDITION_LABELS[c]}
                    {unmet.includes(c) && <strong> (falta)</strong>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {targets.length > 0 && (
            <div>
              <label className="field-label" htmlFor="s-note">
                {needsNote ? 'Comentario (obligatorio)' : 'Comentario (opcional)'}
              </label>
              <textarea
                id="s-note" className="input" rows={3} maxLength={500} value={note}
                placeholder="Queda en el historial del trámite…"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button
            type="submit" className="btn btn-primary"
            disabled={busy || targets.length === 0 || blocked}
          >
            {busy ? 'Avanzando…' : 'Avanzar'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
