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
import { useState } from 'react';
import {
  Currency,
  Permission,
  SHIPMENT_TYPE_LABELS,
  STATE_LABELS,
  State,
  can,
  clientName,
  formatMoney,
} from '@courier/shared';
import type { Role, ShipmentDto } from '@courier/shared';
import { IconButton } from '../components/IconButton';
import { FilterBar } from '../components/FilterBar';
import { EmptyList, ListBody, TableSkeleton } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { PayFlag } from '../components/PayFlag';
import { API_BASE } from '../lib/api';
import { usePagedList } from '../lib/usePagedList';
import { formatDate } from '../lib/datetime';
import { CostsEditorModal } from './CostsEditorModal';

/**
 * Que cola se esta mirando. Una de trabajo y tres de cobro, una por flujo.
 *
 * Son cuatro porque el cobro dejo de vivir en un solo estado: Paqueteria cobra en
 * bodega, Agenciamiento en la proforma y Transporte en la propia facturacion. El
 * listado filtra por UN estado (`state` del endpoint es un enum, no una lista),
 * asi que cada uno necesita su cola.
 *
 * Y por eso `billed` ademas del estado: en Transporte "Facturacion en proceso"
 * contiene las dos cosas, lo que hay que facturar y lo que ya se facturo. El
 * estado solo ya no las separa, la factura si.
 */
export type CostsView = 'pendientes' | 'facturados' | 'transporte' | 'proformas';

const VIEW_FILTER: Record<CostsView, { state: State; billed: 'true' | 'false' }> = {
  pendientes: { state: State.FacturacionEnProceso, billed: 'false' },
  facturados: { state: State.EnBodegaPendientePago, billed: 'true' },
  transporte: { state: State.FacturacionEnProceso, billed: 'true' },
  proformas: { state: State.ProformaPendientePago, billed: 'true' },
};

/** Colas de lo YA facturado: llevan monto, bandera de cobro y proforma. */
const BILLED_VIEWS: readonly CostsView[] = ['facturados', 'transporte', 'proformas'];

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
  const [q, setQ] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ShipmentDto | null>(null);

  /** La cola, paginada. La cola y la busqueda son filtros de SQL, no de pantalla. */
  const list = usePagedList<ShipmentDto>(
    '/shipments',
    { ...VIEW_FILTER[view], q: q.trim() || undefined },
    { errorMessage: 'No se pudo cargar la cola.' },
  );
  const { error, setError, reload: load } = list;

  /** True en las colas de lo ya facturado (ver BILLED_VIEWS). */
  const billed = BILLED_VIEWS.includes(view);

  /** Columnas de la tabla; el esqueleto necesita cuadrar con ellas. */
  const columnCount = billed ? 9 : 8;
  const noun = billed ? 'trámites facturados' : 'trámites por facturar';

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Costos</div>
          {/* El total de la cola, no las filas de la pagina: es el tamaño del
              trabajo pendiente y por eso se mira. */}
          {list.data && <div className="count">{list.total.toLocaleString('es-CR')} {noun}</div>}
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
            <option value="transporte">Transporte por cobrar</option>
            <option value="proformas">Proformas por cobrar</option>
          </select>
        </div>
      </FilterBar>

      <ListBody refreshing={list.refreshing}>
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
              {billed && <th>Pago</th>}
              <th>Fecha ingreso</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          {/* La cabecera se pinta siempre: mientras carga, ya dice qué va a
              llegar. El esqueleto solo reemplaza las filas. */}
          {list.loading && <TableSkeleton cols={columnCount} />}
          <tbody>
            {list.items.map((row) => (
              <tr key={row.id}>
                <td><span className="mono">{row.code}</span></td>
                <td>{SHIPMENT_TYPE_LABELS[row.shipmentType]}</td>
                <td>
                  <div className="cell-name">{clientName(row.client)}</div>
                  {row.client && <span className="mono muted">{row.client.code}</span>}
                </td>
                <td>{row.description}</td>
                <td>
                  <span className="spill"><span className="dot" />{STATE_LABELS[row.state]}</span>
                </td>
                <td>{invoiceLabel(row)}</td>
                {billed && (
                  <td>
                    <PayFlag
                      shipmentType={row.shipmentType}
                      invoiceTotalUsd={row.invoiceTotalUsd}
                      invoiceTotalCrc={row.invoiceTotalCrc}
                      settledUsd={row.settledUsd}
                      settledCrc={row.settledCrc}
                      settled={row.settled}
                      pendingUsd={row.pendingUsd}
                      pendingCrc={row.pendingCrc}
                    />
                  </td>
                )}
                <td>{formatDate(row.createdAt)}</td>
                <td>
                  <div className="actions">
                    <IconButton
                      label={billed ? 'Ver factura' : 'Cargar costos'}
                      icon={billed ? 'receipt' : 'dollar'}
                      onClick={() => setEditing(row)}
                    />
                    {/* Proforma de UN trámite: es la descarga "de una en una" del
                        requerimiento, y va aquí porque es donde se trabaja un
                        trámite concreto. El lote vive en Reportes, sobre el filtro. */}
                    {canProforma && billed && (
                      <IconButton label="Descargar proforma" icon="file" onClick={() => openProforma(row.id)} />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

        <Pagination
          page={list.page}
          pageSize={list.pageSize}
          total={list.total}
          totalPages={list.totalPages}
          onPage={list.goToPage}
          busy={list.refreshing}
          noun={noun}
        />
      </ListBody>

      <EmptyList loading={list.loading} empty={list.items.length === 0}>
        {view === 'pendientes'
          ? 'No hay trámites esperando facturación.'
          : view === 'proformas'
            ? 'No hay proformas esperando pago.'
            : view === 'transporte'
              ? 'No hay trámites de transporte facturados esperando pago.'
              : 'Aún no hay trámites facturados.'}
      </EmptyList>

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
