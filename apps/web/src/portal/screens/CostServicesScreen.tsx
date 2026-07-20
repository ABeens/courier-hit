/**
 * Pantalla "Servicios de costos" (permiso cost_services.manage, solo admin).
 * CRUD del catalogo de conceptos que se cargan a los tramites de Transporte y
 * Agenciamiento o de Paqueteria: crear, editar, habilitar/deshabilitar, buscar
 * por nombre y filtrar por tipo de servicio / tipo de valor / estado.
 * Fuente: docs/manuales/flujo.md L1-20. La API revalida cada accion.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  type Currency,
  SERVICE_KIND_LABELS,
  SERVICE_VALUE_TYPE_LABELS,
  ServiceKind,
  ServiceValueType,
  formatMoney,
} from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { CostServiceFormModal } from './CostServiceFormModal';

export interface CostServiceRow {
  id: string;
  name: string;
  kind: ServiceKind;
  valueType: ServiceValueType;
  defaultValue: number | null;
  currency: Currency | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
interface ListResponse {
  items: CostServiceRow[];
  counts: { total: number; enabled: number };
}

type ModalState = { mode: 'create' } | { mode: 'edit'; row: CostServiceRow } | null;

/** Muestra el valor por defecto legible segun el tipo. */
function formatValue(row: CostServiceRow): string {
  if (row.valueType === ServiceValueType.Manual || row.defaultValue === null) return '—';
  if (row.valueType === ServiceValueType.Percentage) return `${row.defaultValue}%`;
  // Monto fijo: siempre lleva moneda (regla M2); si faltara, no inventamos simbolo.
  return row.currency ? formatMoney(row.defaultValue, row.currency) : String(row.defaultValue);
}

export function CostServicesScreen() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [valueType, setValueType] = useState('');
  const [enabled, setEnabled] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (kind) params.set('kind', kind);
    if (valueType) params.set('valueType', valueType);
    if (enabled) params.set('enabled', enabled);
    const qs = params.toString();
    try {
      setData(await api.get<ListResponse>(`/cost-services${qs ? `?${qs}` : ''}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar el listado.');
    }
  }, [q, kind, valueType, enabled]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce de la busqueda
    return () => clearTimeout(t);
  }, [load]);

  async function toggleEnabled(row: CostServiceRow) {
    setError(null);
    setNotice(null);
    try {
      await api.patch(`/cost-services/${row.id}`, { enabled: !row.enabled });
      setNotice(`${row.name}: ${!row.enabled ? 'habilitado' : 'deshabilitado'}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cambiar el estado.');
    }
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Servicios de costos</div>
          {data && (
            <div className="count">
              {data.counts.enabled} habilitados · {data.counts.total} en total
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={() => setModal({ mode: 'create' })}>
          + Nuevo servicio
        </button>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="filters">
        <input
          className="input search" placeholder="Buscar por nombre…"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Todos los servicios</option>
          {Object.values(ServiceKind).map((k) => (
            <option key={k} value={k}>{SERVICE_KIND_LABELS[k]}</option>
          ))}
        </select>
        <select className="input" value={valueType} onChange={(e) => setValueType(e.target.value)}>
          <option value="">Todos los tipos de valor</option>
          {Object.values(ServiceValueType).map((t) => (
            <option key={t} value={t}>{SERVICE_VALUE_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <select className="input" value={enabled} onChange={(e) => setEnabled(e.target.value)}>
          <option value="">Todos los estados</option>
          <option value="true">Habilitado</option>
          <option value="false">Deshabilitado</option>
        </select>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Servicio</th>
              <th>Tipo de servicio</th>
              <th>Tipo de valor</th>
              <th>Valor por defecto</th>
              <th>Estado</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="cell-name">{row.name}</div>
                </td>
                <td>{SERVICE_KIND_LABELS[row.kind]}</td>
                <td>{SERVICE_VALUE_TYPE_LABELS[row.valueType]}</td>
                <td>{formatValue(row)}</td>
                <td>
                  <span className={`spill ${row.enabled ? 'ok' : 'off'}`}>
                    <span className="dot" />
                    {row.enabled ? 'Habilitado' : 'Deshabilitado'}
                  </span>
                </td>
                <td>
                  <div className="actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setModal({ mode: 'edit', row })}>
                      Editar
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => toggleEnabled(row)}>
                      {row.enabled ? 'Deshabilitar' : 'Habilitar'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.items.length === 0 && <div className="empty">No hay servicios que coincidan.</div>}

      {modal && (
        <CostServiceFormModal
          mode={modal.mode}
          row={modal.mode === 'edit' ? modal.row : undefined}
          onClose={() => setModal(null)}
          onSaved={(message) => {
            setModal(null);
            setNotice(message ?? null);
            setError(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
