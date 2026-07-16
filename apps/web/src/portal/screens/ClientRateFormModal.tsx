/**
 * Modal crear / editar tarifa preferencial de cliente. Campos: nombre, precio por
 * kg, medios de pago (tarjeta / deposito) y si es la tarifa por defecto. En editar
 * solo envia lo que cambio. La API revalida (nombre unico, invariante de default).
 */
import { useState } from 'react';
import { createClientRateSchema } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import type { ClientRateRow } from './TariffsScreen';

interface Props {
  mode: 'create' | 'edit';
  row?: ClientRateRow;
  onClose: () => void;
  onSaved: (message?: string) => void;
}

export function ClientRateFormModal({ mode, row, onClose, onSaved }: Props) {
  const [name, setName] = useState(row?.name ?? '');
  const [price, setPrice] = useState<string>(row?.pricePerKg !== undefined ? String(row.pricePerKg) : '');
  const [allowsCard, setAllowsCard] = useState(row?.allowsCard ?? true);
  const [allowsBankDeposit, setAllowsBankDeposit] = useState(row?.allowsBankDeposit ?? true);
  // Una tarifa por defecto no se puede "desmarcar" desde aqui: solo se promueve otra.
  const [isDefault, setIsDefault] = useState(row?.isDefault ?? false);
  const lockDefault = mode === 'edit' && (row?.isDefault ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const pricePerKg = Number(price);
      if (mode === 'create') {
        const parsed = createClientRateSchema.safeParse({
          name,
          pricePerKg,
          allowsCard,
          allowsBankDeposit,
          isDefault,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
          setBusy(false);
          return;
        }
        await api.post('/tariffs/client-rates', parsed.data);
        onSaved(`Tarifa "${parsed.data.name}" creada.`);
      } else if (row) {
        // Solo enviamos lo que cambio.
        const patch: Record<string, unknown> = {};
        if (name.trim() !== row.name) patch.name = name.trim();
        if (pricePerKg !== row.pricePerKg) patch.pricePerKg = pricePerKg;
        if (allowsCard !== row.allowsCard) patch.allowsCard = allowsCard;
        if (allowsBankDeposit !== row.allowsBankDeposit) patch.allowsBankDeposit = allowsBankDeposit;
        if (!row.isDefault && isDefault) patch.isDefault = true;
        if (Object.keys(patch).length === 0) {
          onSaved();
          return;
        }
        // Validaciones basicas de cliente (la API es la barrera real).
        if (patch.name !== undefined && !String(patch.name).trim()) {
          setError('El nombre es obligatorio.');
          setBusy(false);
          return;
        }
        if (patch.pricePerKg !== undefined && !(pricePerKg > 0)) {
          setError('El precio por kg debe ser mayor que cero.');
          setBusy(false);
          return;
        }
        if (!allowsCard && !allowsBankDeposit) {
          setError('La tarifa debe permitir al menos un medio de pago.');
          setBusy(false);
          return;
        }
        await api.patch(`/tariffs/client-rates/${row.id}`, patch);
        onSaved(`Tarifa "${name.trim() || row.name}" actualizada.`);
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
          <h3>{mode === 'create' ? 'Nueva tarifa' : 'Editar tarifa'}</h3>
          <p>Categorías preferenciales por kg que se asignan a los casilleros.</p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}

          <div>
            <label className="field-label" htmlFor="r-name">Nombre de la tarifa</label>
            <input
              id="r-name" className="input" value={name} autoFocus
              placeholder="Ej: Gold"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="r-price">Precio por kg ($)</label>
            <input
              id="r-price" className="input" type="number" min="0" step="0.01"
              value={price} placeholder="8.15"
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>

          <div>
            <span className="field-label">Medios de pago permitidos</span>
            <label className="check-row">
              <input type="checkbox" checked={allowsCard} onChange={(e) => setAllowsCard(e.target.checked)} />
              Tarjeta de crédito
            </label>
            <label className="check-row">
              <input
                type="checkbox" checked={allowsBankDeposit}
                onChange={(e) => setAllowsBankDeposit(e.target.checked)}
              />
              Depósito bancario
            </label>
          </div>

          <div>
            <label className="check-row">
              <input
                type="checkbox" checked={isDefault} disabled={lockDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
              />
              Tarifa por defecto (casilleros nuevos)
            </label>
            {lockDefault && (
              <div className="cell-sub">Ya es la tarifa por defecto. Para cambiarla, marca otra como predeterminada.</div>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Guardando…' : mode === 'create' ? 'Crear tarifa' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </div>
  );
}
