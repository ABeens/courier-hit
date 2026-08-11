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
  Permission,
  SHIPMENT_TYPE_LABELS,
  STATE_LABELS,
  State,
  can,
  formatMoney,
} from '@courier/shared';
import type { Role, ShipmentDto } from '@courier/shared';
import { FilterBar } from '../components/FilterBar';
import { PayFlag } from '../components/PayFlag';
import { API_BASE, ApiError, api } from '../lib/api';
import { formatDate } from '../lib/datetime';
import { CostsEditorModal } from './CostsEditorModal';

interface ListResponse {
  items: ShipmentDto[];
}

/** Que cola se esta mirando. */
export type CostsView = 'pendientes' | 'facturados';

const VIEW_STATE: Record<CostsView, State> = {
  pendientes: State.FacturacionEnProceso,
  facturados: State.EnBodegaPendientePago,
};

/**
 * Abre la proforma de un tramite en otra pestaña. Navegacion normal y no `fetch`:
 * es un documento para leer o imprimir, y la cookie de sesion viaja igual por ser
 * el mismo origen (mismo criterio que la descarga del CSV de reportes).
 */
function openProforma(shipmentId: string) {
  window.open(`${API_BASE}/api/reports/proforma/${shipmentId}`, '_blank');
}

/** Monto de factura en las dos monedas; guion si aun no se aprobo. */
function invoiceLabel(row: ShipmentDto): string {
  if (row.invoiceTotalUsd === null || row.invoiceTotalCrc === null) return '—';
  return `${formatMoney(row.invoiceTotalUsd, Currency.USD)} · ${formatMoney(row.invoiceTotalCrc, Currency.CRC)}`;
}

/**
 * `initialView` solo fija la cola de arranque: se usa al llegar desde el
 * Resumen (`NavIntent`), donde el cuadro pulsado ya dice cual de las dos
 * interesa. El selector sigue mandando a partir de ahi.
 */
export function CostsScreen({ role, initialView = 'pendientes' }: { role: Role; initialView?: CostsView }) {
  const [view, setView] = useState<CostsView>(initialView);
  /**
   * Quién puede emitir proformas sale del permiso, igual que en el servidor. Se
   * pregunta con `can` y no se deduce del rol: sumar el permiso a otro rol tiene
   * que bastar para que le aparezca el botón.
   */
  const canProforma = can(role, Permission.ReportsProforma);
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

      <FilterBar
        search={{
          value: q,
          onChange: setQ,
          placeholder: 'Buscar por consecutivo, tracking, descripción o cliente…',
        }}
        /* La cola no es un filtro que se "quite": siempre tiene valor, y el
           contador de la cabecera ya dice cual esta puesta. */
        chips={[]}
        onClearAll={() => {}}
      >
        <div>
          <label className="field-label" htmlFor="f-view">Cola</label>
          <select
            id="f-view" className="input" value={view}
            onChange={(e) => setView(e.target.value as CostsView)}
          >
            <option value="pendientes">Por facturar</option>
            <option value="facturados">Ya facturados</option>
          </select>
        </div>
      </FilterBar>

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
              {/* Solo tiene sentido sobre lo ya facturado: en la cola de "por
                  facturar" todavía no hay monto que cobrar y la columna saldría
                  vacía en todas las filas. */}
              {view === 'facturados' && <th>Pago</th>}
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
                {view === 'facturados' && (
                  <td>
                    <PayFlag
                      invoiceTotalCrc={row.invoiceTotalCrc}
                      settledCrc={row.settledCrc}
                      settled={row.settled}
                      pendingCrc={row.pendingCrc}
                    />
                  </td>
                )}
                <td>{formatDate(row.createdAt)}</td>
                <td>
                  <div className="actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(row)}>
                      {view === 'pendientes' ? 'Cargar costos' : 'Ver factura'}
                    </button>
                    {/* Proforma de UN trámite: es la descarga "de una en una" del
                        requerimiento, y va aquí porque es donde se trabaja un
                        trámite concreto. El lote vive en Reportes, sobre el filtro. */}
                    {canProforma && view === 'facturados' && (
                      <button className="btn btn-ghost btn-sm" onClick={() => openProforma(row.id)}>
                        Proforma
                      </button>
                    )}
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
          role={role}
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
