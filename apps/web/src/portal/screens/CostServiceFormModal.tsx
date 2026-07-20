/**
 * Modal crear / editar servicio de costo. Dos reglas encadenadas:
 *   - El tipo de servicio acota el tipo de valor: Transporte y Agenciamiento se
 *     carga al recibir el tramite, asi que queda fijo en Manual; Paqueteria elige.
 *   - El tipo de valor decide si se pide un valor por defecto: Porcentaje/Monto
 *     fijo lo exigen; Manual lo oculta (el importe se digita al cargar).
 * En editar solo envia lo que cambio.
 */
import { useState } from 'react';
import { ModalOverlay } from '../components/ModalOverlay';
import {
  CURRENCY_LABELS,
  Currency,
  SERVICE_KIND_LABELS,
  SERVICE_VALUE_TYPE_LABELS,
  ServiceKind,
  ServiceValueType,
  allowedCurrencies,
  allowedValueTypes,
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
  const [kind, setKind] = useState<ServiceKind>(row?.kind ?? ServiceKind.TransporteAgenciamiento);
  const [valueType, setValueType] = useState<ServiceValueType>(row?.valueType ?? ServiceValueType.Manual);
  const [value, setValue] = useState<string>(
    row?.defaultValue !== null && row?.defaultValue !== undefined ? String(row.defaultValue) : '',
  );
  const [currency, setCurrency] = useState<Currency>(row?.currency ?? Currency.USD);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const valueTypeOptions = allowedValueTypes(kind);
  const lockedToManual = valueTypeOptions.length === 1;
  const needsValue = valueType !== ServiceValueType.Manual;
  // Solo el monto fijo es dinero: lleva moneda. Porcentaje y manual no (regla M2).
  const needsCurrency = valueType === ServiceValueType.Fixed;
  // Paqueteria (compras en USA) solo admite dolares: el selector se muestra fijo.
  const currencyOptions = allowedCurrencies(kind);
  const lockCurrency = currencyOptions.length === 1;
  const parsedValue = needsValue ? Number(value) : null;

  /** Al cambiar de tipo de servicio, reencaja tipo de valor y moneda si dejaron de ser admisibles. */
  function changeKind(next: ServiceKind) {
    setKind(next);
    if (!allowedValueTypes(next).includes(valueType)) setValueType(ServiceValueType.Manual);
    const nextCurrencies = allowedCurrencies(next);
    if (!nextCurrencies.includes(currency)) setCurrency(Currency.USD);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'create') {
        const parsed = createCostServiceSchema.safeParse({
          name,
          kind,
          valueType,
          defaultValue: needsValue ? parsedValue : undefined,
          currency: needsCurrency ? currency : undefined,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
          setBusy(false);
          return;
        }
        await api.post('/cost-services', parsed.data);
        onSaved(`Servicio "${parsed.data.name}" creado.`);
      } else if (row) {
        // Solo enviamos lo que cambio. Tipo de servicio, tipo y valor van acoplados.
        const patch: Record<string, unknown> = {};
        if (name.trim() !== row.name) patch.name = name.trim();
        const valueChanged = needsValue
          ? parsedValue !== row.defaultValue
          : row.defaultValue !== null;
        const currencyChanged = needsCurrency ? currency !== row.currency : row.currency !== null;
        if (kind !== row.kind || valueType !== row.valueType || valueChanged || currencyChanged) {
          patch.kind = kind;
          patch.valueType = valueType;
          patch.defaultValue = needsValue ? parsedValue : null;
          patch.currency = needsCurrency ? currency : null;
        }
        if (Object.keys(patch).length === 0) {
          onSaved();
          return;
        }
        // Validamos coherencia servicio<->tipo<->valor reusando el esquema de creacion.
        const check = createCostServiceSchema.safeParse({
          name: name.trim() || row.name,
          kind,
          valueType,
          defaultValue: needsValue ? parsedValue : undefined,
          currency: needsCurrency ? currency : undefined,
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
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>{mode === 'create' ? 'Nuevo servicio' : 'Editar servicio'}</h3>
          <p>Conceptos de costo para trámites de Transporte y agenciamiento o de Paquetería.</p>
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
            <label className="field-label" htmlFor="s-kind">Tipo de servicio</label>
            <select
              id="s-kind" className="input" value={kind}
              onChange={(e) => changeKind(e.target.value as ServiceKind)}
            >
              {Object.values(ServiceKind).map((k) => (
                <option key={k} value={k}>{SERVICE_KIND_LABELS[k]}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="field-label" htmlFor="s-type">Tipo de valor</label>
            <select
              id="s-type" className="input" value={valueType} disabled={lockedToManual}
              onChange={(e) => setValueType(e.target.value as ServiceValueType)}
            >
              {valueTypeOptions.map((t) => (
                <option key={t} value={t}>{SERVICE_VALUE_TYPE_LABELS[t]}</option>
              ))}
            </select>
            {lockedToManual && (
              <div className="field-hint">
                Los costos de {SERVICE_KIND_LABELS[ServiceKind.TransporteAgenciamiento]} se cargan al momento
                de recibir el trámite, por eso su valor siempre es manual.
              </div>
            )}
          </div>

          {needsValue ? (
            <div className={needsCurrency ? 'field-pair' : undefined}>
              <div>
                <label className="field-label" htmlFor="s-value">
                  {valueType === ServiceValueType.Percentage ? 'Porcentaje por defecto (%)' : 'Monto por defecto'}
                </label>
                <input
                  id="s-value" className="input" type="number" min="0"
                  max={valueType === ServiceValueType.Percentage ? '100' : undefined}
                  step={valueType === ServiceValueType.Percentage ? '0.1' : '0.01'}
                  value={value} onChange={(e) => setValue(e.target.value)}
                  placeholder={valueType === ServiceValueType.Percentage ? '10' : '0.00'}
                />
              </div>
              {needsCurrency && (
                <div>
                  <label className="field-label" htmlFor="s-currency">Moneda</label>
                  <select
                    id="s-currency" className="input" value={currency} disabled={lockCurrency}
                    onChange={(e) => setCurrency(e.target.value as Currency)}
                  >
                    {currencyOptions.map((c) => (
                      <option key={c} value={c}>{CURRENCY_LABELS[c]}</option>
                    ))}
                  </select>
                  {lockCurrency && (
                    <div className="field-hint">
                      Los servicios de {SERVICE_KIND_LABELS[ServiceKind.Paqueteria]} se cotizan en dólares.
                    </div>
                  )}
                </div>
              )}
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
    </ModalOverlay>
  );
}
