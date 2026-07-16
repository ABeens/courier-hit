/**
 * Modal crear / editar servicio de costo. El tipo de valor decide si se pide un
 * valor por defecto: Porcentaje/Monto fijo lo exigen; Manual lo oculta (el importe
 * se digita al cargar los costos del tramite). En editar solo envia lo que cambio.
 */
import { useState } from 'react';
import {
  SERVICE_VALUE_TYPE_LABELS,
  ServiceValueType,
  createCostServiceSchema,
} from '@courier/shared';
import { ApiError, api } from '../lib/api';
import type { CostServiceRow } from './CostServicesScreen';

interface Props {
  mode: 'create' | 'edit';
  row?: CostServiceRow;
  onClose: () => void;
  onSaved: (message?: string) => void;
}

export function CostServiceFormModal({ mode, row, onClose, onSaved }: Props) {
  const [name, setName] = useState(row?.name ?? '');
  const [valueType, setValueType] = useState<ServiceValueType>(row?.valueType ?? ServiceValueType.Manual);
  const [value, setValue] = useState<string>(
    row?.defaultValue !== null && row?.defaultValue !== undefined ? String(row.defaultValue) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsValue = valueType !== ServiceValueType.Manual;
  const parsedValue = needsValue ? Number(value) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'create') {
        const parsed = createCostServiceSchema.safeParse({
          name,
          valueType,
          defaultValue: needsValue ? parsedValue : undefined,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
          setBusy(false);
          return;
        }
        await api.post('/cost-services', parsed.data);
        onSaved(`Servicio "${parsed.data.name}" creado.`);
      } else if (row) {
        // Solo enviamos lo que cambio. Tipo y valor van acoplados.
        const patch: Record<string, unknown> = {};
        if (name.trim() !== row.name) patch.name = name.trim();
        const valueChanged = needsValue
          ? parsedValue !== row.defaultValue
          : row.defaultValue !== null;
        if (valueType !== row.valueType || valueChanged) {
          patch.valueType = valueType;
          patch.defaultValue = needsValue ? parsedValue : null;
        }
        if (Object.keys(patch).length === 0) {
          onSaved();
          return;
        }
        // Validamos coherencia tipo<->valor reusando el esquema de creacion.
        const check = createCostServiceSchema.safeParse({
          name: name.trim() || row.name,
          valueType,
          defaultValue: needsValue ? parsedValue : undefined,
        });
        if (!check.success) {
          setError(check.error.issues[0]?.message ?? 'Datos inválidos.');
          setBusy(false);
          return;
        }
        await api.patch(`/cost-services/${row.id}`, patch);
        onSaved(`Servicio "${name.trim() || row.name}" actualizado.`);
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
          <h3>{mode === 'create' ? 'Nuevo servicio' : 'Editar servicio'}</h3>
          <p>Conceptos de costo para trámites de Transporte y Agenciamiento.</p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}

          <div>
            <label className="field-label" htmlFor="s-name">Nombre del servicio</label>
            <input
              id="s-name" className="input" value={name} autoFocus
              placeholder="Ej: Permisos de Importación"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="s-type">Tipo de valor</label>
            <select
              id="s-type" className="input" value={valueType}
              onChange={(e) => setValueType(e.target.value as ServiceValueType)}
            >
              {Object.values(ServiceValueType).map((t) => (
                <option key={t} value={t}>{SERVICE_VALUE_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>

          {needsValue ? (
            <div>
              <label className="field-label" htmlFor="s-value">
                {valueType === ServiceValueType.Percentage ? 'Porcentaje por defecto (%)' : 'Monto por defecto ($)'}
              </label>
              <input
                id="s-value" className="input" type="number" min="0"
                max={valueType === ServiceValueType.Percentage ? '100' : undefined}
                step={valueType === ServiceValueType.Percentage ? '0.1' : '0.01'}
                value={value} onChange={(e) => setValue(e.target.value)}
                placeholder={valueType === ServiceValueType.Percentage ? '10' : '0.00'}
              />
            </div>
          ) : (
            <div className="banner ok" style={{ background: 'var(--paper-2)', color: 'var(--muted)' }}>
              El importe de este servicio se digita al cargar los costos del trámite.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Guardando…' : mode === 'create' ? 'Crear servicio' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </div>
  );
}
