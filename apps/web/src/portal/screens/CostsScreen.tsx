/**
 * Pantalla "Costos" (permisos costs.manage / costs.tramite.manage).
 *
 * Es la COLA DE FACTURACION, no un catalogo: lista los tramites parados en
 * "Facturación en proceso" —los que esperan que alguien les cargue el costo— y
 * abre el editor sobre cada uno. El catalogo de conceptos es la otra pantalla
 * ("Servicios de costos", permiso cost_services.manage).
 *
 * Por defecto muestra solo la cola pendiente. El selector permite ver tambien lo
 * ya facturado, para consultar una factura congelada sin poder editarla.
 * Fuente: docs/06-modulo-administrativo.md §3.3.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Currency,
  SHIPMENT_TYPE_LABELS,
  STATE_LABELS,
  State,
  formatMoney,
} from '@courier/shared';
import type { ShipmentDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/datetime';
import { CostsEditorModal } from './CostsEditorModal';

interface ListResponse {
  items: ShipmentDto[];
}

/** Que cola se esta mirando. */
type View = 'pendientes' | 'facturados';

const VIEW_STATE: Record<View, State> = {
  pendientes: State.FacturacionEnProceso,
  facturados: State.EnBodegaPendientePago,
};

/** Monto de factura en las dos monedas; guion si aun no se aprobo. */
function invoiceLabel(row: ShipmentDto): string {
  if (row.invoiceTotalUsd === null || row.invoiceTotalCrc === null) return '—';
  return `${formatMoney(row.invoiceTotalUsd, Currency.USD)} · ${formatMoney(row.invoiceTotalCrc, Currency.CRC)}`;
}

export function CostsScreen() {
  const [view, setView] = useState<View>('pendientes');
  const [data, setData] = useState<ListResponse | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ShipmentDto | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ state: VIEW_STATE[view] });
    if (q.trim()) params.set('q', q.trim());
    try {
      setData(await api.get<ListResponse>(`/shipments?${params.toString()}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar la cola.');
    }
  }, [q, view]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce de la busqueda
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Costos</div>
          {data && (
            <div className="count">
              {data.items.length}{' '}
              {view === 'pendientes' ? 'trámites por facturar' : 'trámites facturados'}
            </div>
          )}
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="filters">
        <input
          className="input search" placeholder="Buscar por consecutivo, tracking, descripción o cliente…"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
        <select className="input" value={view} onChange={(e) => setView(e.target.value as View)}>
          <option value="pendientes">Por facturar</option>
          <option value="facturados">Ya facturados</option>
        </select>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Consecutivo</th>
              <th>Trámite</th>
              <th>Cliente</th>
              <th>Descripción (REF)</th>
              <th>Estado</th>
              <th>Monto de factura</th>
              <th>Fecha ingreso</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((row) => (
              <tr key={row.id}>
                <td><span className="mono">{row.code}</span></td>
                <td>{SHIPMENT_TYPE_LABELS[row.shipmentType]}</td>
                <td>
                  <div className="cell-name">{row.client.name}</div>
                  <span className="mono muted">{row.client.code}</span>
                </td>
                <td>{row.description}</td>
                <td>
                  <span className="spill"><span className="dot" />{STATE_LABELS[row.state]}</span>
                </td>
                <td>{invoiceLabel(row)}</td>
                <td>{formatDate(row.createdAt)}</td>
                <td>
                  <div className="actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(row)}>
                      {view === 'pendientes' ? 'Cargar costos' : 'Ver factura'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.items.length === 0 && (
        <div className="empty">
          {view === 'pendientes'
            ? 'No hay trámites esperando facturación.'
            : 'Aún no hay trámites facturados.'}
        </div>
      )}

      {editing && (
        <CostsEditorModal
          shipment={editing}
          onClose={() => {
            setEditing(null);
            void load();
          }}
          onApproved={(message) => {
            setEditing(null);
            setNotice(message);
            setError(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
