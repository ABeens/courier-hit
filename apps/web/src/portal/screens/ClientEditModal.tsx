/**
 * Edición comercial de un casillero (permiso clients.write) — Parte 3.
 *
 * Solo se editan las dos decisiones comerciales: la tarifa y el límite de
 * crédito. El contacto y la dirección los mantiene el propio cliente desde su
 * perfil; duplicar aquí esa edición abriría la puerta a que las dos versiones
 * se contradigan.
 *
 * Guardar apaga el flag "Nuevo" del casillero. No es un checkbox: el manual lo
 * define como consecuencia de haber revisado, y un checkbox permitiría marcarlo
 * como revisado sin mirar nada.
 */
import { useEffect, useState } from 'react';
import { CURRENCY_LABELS, Currency } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';
import type { ClientRow } from './ClientsScreen';

interface Rate {
  id: string;
  name: string;
  pricePerKg: number;
  currency: Currency;
}

interface Props {
  row: ClientRow;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function ClientEditModal({ row, onClose, onSaved }: Props) {
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [clientRateId, setClientRateId] = useState(row.clientRateId ?? '');
  const [creditLimit, setCreditLimit] = useState(
    row.creditLimit != null ? String(row.creditLimit) : '',
  );
  const [currency, setCurrency] = useState<Currency>(row.creditLimitCurrency ?? Currency.USD);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // El selector de tarifas se carga al abrir: son pocas y cambian poco, pero
  // tienen que ser las vigentes, no una copia que traiga la fila del listado.
  useEffect(() => {
    void api
      .get<{ items: Rate[] }>('/tariffs')
      .then((data) => setRates(data.items))
      .catch(() => setRates([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = creditLimit.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      setError('El límite de crédito debe ser un número mayor o igual a cero.');
      return;
    }

    setSaving(true);
    try {
      await api.patch(`/clients/${row.id}`, {
        ...(clientRateId ? { clientRateId } : {}),
        creditLimit: parsed,
        // La moneda viaja SIEMPRE junto al límite (regla M2). Si se borra el
        // límite se limpia también: una moneda suelta no describe nada.
        creditLimitCurrency: parsed === null ? null : currency,
      });
      onSaved(`${row.name}: datos actualizados y casillero marcado como revisado.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar el cliente.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Editar cliente</h3>
          <p>
            {row.code} · {row.name}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}

          <div>
            <label className="field-label" htmlFor="c-rate">Tarifa asignada</label>
            <select
              id="c-rate"
              className="input"
              value={clientRateId}
              onChange={(e) => setClientRateId(e.target.value)}
            >
              <option value="">— Sin cambiar —</option>
              {rates?.map((rate) => (
                <option key={rate.id} value={rate.id}>
                  {rate.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field-pair">
            <div>
              <label className="field-label" htmlFor="c-credit">Límite de crédito</label>
              <input
                id="c-credit"
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={creditLimit}
                placeholder="Sin límite"
                onChange={(e) => setCreditLimit(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="c-currency">Moneda del límite</label>
              <select
                id="c-currency"
                className="input"
                value={currency}
                disabled={creditLimit.trim() === ''}
                onChange={(e) => setCurrency(e.target.value as Currency)}
              >
                {Object.values(Currency).map((c) => (
                  <option key={c} value={c}>
                    {CURRENCY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="banner" style={{ marginTop: 4 }}>
            Al guardar, el casillero deja de figurar como <strong>Nuevo</strong>.
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
