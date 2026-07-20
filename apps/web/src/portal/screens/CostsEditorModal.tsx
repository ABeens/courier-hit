/**
 * Editor de costos de un tramite (permiso costs.manage / costs.tramite.manage).
 *
 * Tres reglas que se ven en pantalla:
 *   - La TASA DE CAMBIO la digita el operador. El sistema la sugiere (BCCR) pero
 *     el campo es editable y obligatorio: es la tasa que queda guardada en cada
 *     linea (regla M5). Sin tasa no se guarda.
 *   - Las lineas de PORCENTAJE no llevan monto: el importe lo calcula la API
 *     sobre el subtotal de las demas. Aqui solo se muestra la estimacion.
 *   - APROBAR CONGELA. Guarda, fija el monto de factura y avanza el tramite a
 *     "En bodega - Pendiente pago". Desde ahi ya no se edita.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  CURRENCY_LABELS,
  CostLineSource,
  Currency,
  STATE_LABELS,
  State,
  computeTotals,
  formatMoney,
} from '@courier/shared';
import type { ShipmentCostsDto, ShipmentDto, SuggestedCostLine } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/datetime';

interface Props {
  shipment: ShipmentDto;
  onClose: () => void;
  /** Se llama tras aprobar (el tramite cambio de estado y sale de la cola). */
  onApproved: (message: string) => void;
}

/** Linea en edicion. `key` es local: las lineas nuevas aun no tienen id de BD. */
interface DraftLine {
  key: string;
  costServiceId: string | null;
  label: string;
  source: CostLineSource;
  /** Texto crudo del input: se convierte a numero solo al guardar. */
  percentage: string;
  amount: string;
  currency: Currency;
}

let keySeq = 0;
const nextKey = () => `l${++keySeq}`;

/** Sugerencia del catalogo -> linea en edicion. */
function fromSuggestion(s: SuggestedCostLine): DraftLine {
  return {
    key: nextKey(),
    costServiceId: s.costServiceId,
    label: s.label,
    source: s.source,
    percentage: s.percentage !== null ? String(s.percentage) : '',
    amount: s.amount !== null ? String(s.amount) : '',
    currency: s.currency,
  };
}

export function CostsEditorModal({ shipment, onClose, onApproved }: Props) {
  const [data, setData] = useState<ShipmentCostsDto | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [rate, setRate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const dto = await api.get<ShipmentCostsDto>(`/costs/${shipment.id}`);
      setData(dto);
      setLines(
        dto.lines.map((l) => ({
          key: nextKey(),
          costServiceId: l.costServiceId,
          label: l.label,
          source: l.source,
          percentage: l.percentage !== null ? String(l.percentage) : '',
          amount: String(l.amount),
          currency: l.currency,
        })),
      );
      // La tasa guardada manda sobre la sugerida: si el tramite ya se cargo con
      // una tasa, cambiarla en silencio movería una factura ya cotizada.
      const saved = dto.lines[0]?.exchangeRate;
      setRate(String(saved ?? dto.suggestedExchangeRate ?? ''));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los costos.');
    }
  }, [shipment.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const approved = data?.approved ?? false;
  const parsedRate = Number(rate);
  const rateOk = Number.isFinite(parsedRate) && parsedRate > 0;

  /**
   * Totales de la vista previa. Se calculan con el MISMO helper del dominio que
   * usa la API (`computeTotals`), asi lo que el operador ve antes de guardar es
   * lo que se va a congelar. Los porcentajes se estiman sobre el subtotal.
   */
  const preview = (() => {
    if (!rateOk) return null;
    const fixed = lines
      .filter((l) => l.source !== CostLineSource.Percentage)
      .map((l) => ({ amount: Number(l.amount) || 0, currency: l.currency, exchangeRate: parsedRate }));
    const percentages = lines
      .filter((l) => l.source === CostLineSource.Percentage)
      .map((l) => {
        const base = computeTotals(fixed);
        const subtotal = l.currency === Currency.USD ? base.usd : base.crc;
        return {
          amount: (subtotal * (Number(l.percentage) || 0)) / 100,
          currency: l.currency,
          exchangeRate: parsedRate,
        };
      });
    return computeTotals([...fixed, ...percentages]);
  })();

  function patchLine(key: string, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function save(): Promise<boolean> {
    setError(null);
    if (!rateOk) {
      setError('Digita la tasa de cambio del día (colones por 1 dólar).');
      return false;
    }
    const payload = {
      lines: lines.map((l) => ({
        costServiceId: l.costServiceId,
        label: l.label.trim(),
        source: l.source,
        percentage: l.source === CostLineSource.Percentage ? Number(l.percentage) : null,
        // En porcentaje el importe lo calcula la API; mandarlo seria ruido.
        ...(l.source === CostLineSource.Percentage ? {} : { amount: Number(l.amount) }),
        currency: l.currency,
        exchangeRate: parsedRate,
      })),
    };
    try {
      const dto = await api.put<ShipmentCostsDto>(`/costs/${shipment.id}`, payload);
      setData(dto);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron guardar los costos.');
      return false;
    }
  }

  async function onSave() {
    setBusy(true);
    setNotice(null);
    if (await save()) setNotice('Costos guardados.');
    setBusy(false);
  }

  /** Aprobar guarda primero: nunca se congela un total distinto al que se ve. */
  async function onApprove() {
    if (lines.length === 0) {
      setError('Agrega al menos una línea de costo antes de aprobar.');
      return;
    }
    const confirmed = window.confirm(
      `Al aprobar se congela el monto de factura y el trámite ${shipment.code} pasa a ` +
        `"${STATE_LABELS[State.EnBodegaPendientePago]}". Después ya no se puede editar. ¿Continuar?`,
    );
    if (!confirmed) return;

    setBusy(true);
    setNotice(null);
    if (await save()) {
      try {
        await api.post<ShipmentCostsDto>(`/costs/${shipment.id}/approve`);
        onApproved(`Costos de ${shipment.code} aprobados.`);
        return;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'No se pudieron aprobar los costos.');
      }
    }
    setBusy(false);
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal modal-wide fadeUp" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Costos · {shipment.code}</h3>
          <p>
            {shipment.client.code} — {shipment.client.name} · {shipment.description}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}
          {notice && <div className="banner ok">{notice}</div>}

          {approved && (
            <div className="banner ok">
              Aprobado el {formatDate(data!.approvedAt!)}
              {data!.approvedByName ? ` por ${data!.approvedByName}` : ''}. La factura quedó congelada.
            </div>
          )}

          <div>
            <label className="field-label" htmlFor="c-rate">
              Tasa de cambio del día (colones por 1 dólar)
            </label>
            <input
              id="c-rate" className="input" type="number" min="0" step="0.01"
              value={rate} disabled={approved} placeholder="512.75"
              onChange={(e) => setRate(e.target.value)}
            />
            <div className="field-hint">
              {data?.suggestedExchangeRate != null
                ? `Sugerida por el BCCR: ${data.suggestedExchangeRate}. Puedes ajustarla.`
                : 'Se guarda junto a cada línea, así la factura queda trazable.'}
            </div>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Concepto</th>
                  <th style={{ width: 130 }}>Monto</th>
                  <th style={{ width: 130 }}>Moneda</th>
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key}>
                    <td>
                      <input
                        className="input" value={line.label} disabled={approved}
                        onChange={(e) => patchLine(line.key, { label: e.target.value })}
                      />
                    </td>
                    <td>
                      {line.source === CostLineSource.Percentage ? (
                        <input
                          className="input" type="number" min="0" max="100" step="0.1"
                          value={line.percentage} disabled={approved}
                          onChange={(e) => patchLine(line.key, { percentage: e.target.value })}
                          aria-label={`Porcentaje de ${line.label}`}
                        />
                      ) : (
                        <input
                          className="input" type="number" min="0" step="0.01"
                          value={line.amount} disabled={approved}
                          onChange={(e) => patchLine(line.key, { amount: e.target.value })}
                          aria-label={`Monto de ${line.label}`}
                        />
                      )}
                    </td>
                    <td>
                      {line.source === CostLineSource.Percentage ? (
                        <span className="muted">% del subtotal</span>
                      ) : (
                        <select
                          className="input" value={line.currency} disabled={approved}
                          onChange={(e) => patchLine(line.key, { currency: e.target.value as Currency })}
                          aria-label={`Moneda de ${line.label}`}
                        >
                          {Object.values(Currency).map((c) => (
                            <option key={c} value={c}>{CURRENCY_LABELS[c]}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {!approved && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                        >
                          Quitar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {lines.length === 0 && <div className="empty">Aún no hay líneas de costo.</div>}

          {!approved && (data?.suggestions.length ?? 0) > 0 && (
            <div>
              <div className="field-label">Agregar del catálogo</div>
              <div className="actions" style={{ flexWrap: 'wrap' }}>
                {data!.suggestions.map((s, i) => (
                  <button
                    key={`${s.costServiceId ?? 'freight'}-${i}`}
                    className="btn btn-ghost btn-sm"
                    onClick={() => setLines((prev) => [...prev, fromSuggestion(s)])}
                  >
                    + {s.label}
                    {s.detail ? ` (${s.detail})` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="banner ok" style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}>
            {preview ? (
              <>
                <strong>Total:</strong> {formatMoney(preview.usd, Currency.USD)} ·{' '}
                {formatMoney(preview.crc, Currency.CRC)}
                {!approved && <span className="muted"> (estimado hasta guardar)</span>}
              </>
            ) : (
              'Digita la tasa de cambio para ver el total.'
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {approved ? 'Cerrar' : 'Cancelar'}
          </button>
          {!approved && (
            <>
              <button type="button" className="btn btn-ghost" onClick={onSave} disabled={busy}>
                {busy ? 'Guardando…' : 'Guardar'}
              </button>
              <button type="button" className="btn btn-primary" onClick={onApprove} disabled={busy}>
                Aprobar y avanzar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
