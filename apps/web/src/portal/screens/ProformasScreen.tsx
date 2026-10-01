/**
 * Pantalla "Proformas" (permiso proformas.read; operar pide proformas.manage).
 * Especificacion: docs/proformas-cambios.html.
 *
 * Es la bandeja del modulo: los borradores que arma el sistema al recibir los
 * paquetes, las proformas aprobadas esperando pago y las pagadas. Desde aqui se
 * aprueba (una o varias a la vez), se envian a ruta las pagadas de Paqueteria
 * (permiso de entregas) y se entra al detalle, donde se ajusta el borrador, se
 * corrige una aprobada o se registra un deposito.
 *
 * Reemplaza a la antigua cola de "Costos" por tramite: con el modulo de
 * proformas lo que se revisa y se aprueba es la proforma, no el tramite suelto.
 */
import { useState } from 'react';
import {
  Currency,
  FLOW_LABELS,
  Flow,
  PROFORMA_DELIVERY_STATUS_LABELS,
  PROFORMA_STATUS_LABELS,
  Permission,
  ProformaDeliveryStatus,
  ProformaStatus,
  can,
  formatMoney,
} from '@courier/shared';
import type { ApproveProformasResult, DispatchProformasResult, ProformaListItem, Role } from '@courier/shared';
import { FilterBar } from '../components/FilterBar';
import type { FilterChip } from '../components/FilterBar';
import { IconButton } from '../components/IconButton';
import { EmptyList, ListBody, TableSkeleton } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { API_BASE, ApiError, api } from '../lib/api';
import { formatDate, formatDayInput, startOfLocalDayUtc, startOfNextLocalDayUtc } from '../lib/datetime';
import { usePagedList } from '../lib/usePagedList';
import { ProformaDetailModal } from './ProformaDetailModal';

/** Clase del indicador de estado de la proforma. */
export function proformaStatusPill(status: ProformaStatus): string {
  if (status === ProformaStatus.Pagada) return 'spill ok';
  if (status === ProformaStatus.Aprobada) return 'spill warn';
  return 'spill off';
}

/** Clase del indicador de entrega. */
export function deliveryPill(status: ProformaDeliveryStatus): string {
  if (status === ProformaDeliveryStatus.Entregada || status === ProformaDeliveryStatus.Cerrada) return 'spill ok';
  if (status === ProformaDeliveryStatus.EntregadaParcial) return 'spill warn';
  return 'spill off';
}

/** El total en la moneda en que se cobra la proforma. */
export function proformaTotal(item: Pick<ProformaListItem, 'currency' | 'totals'>): string {
  return formatMoney(item.currency === Currency.USD ? item.totals.usd : item.totals.crc, item.currency);
}

type DispatchFields = Pick<ProformaListItem, 'flow' | 'status' | 'readyForRouteCount' | 'paymentGateWaived'>;

/**
 * Aprobada SIN pagar de un casillero exento de la retencion por pago: sale a
 * ruta igual, pero la pantalla lo tiene que advertir cada vez que lo ofrece.
 */
export function dispatchesUnpaid(item: DispatchFields): boolean {
  return item.status === ProformaStatus.Aprobada && item.paymentGateWaived;
}

/**
 * De Paqueteria y con paquetes en bodega, y ademas pagada (o aprobada sin pagar
 * si el casillero esta exento): la puede sacar a ruta quien tiene el permiso de
 * entregas. La misma regla que aplica `proformasService.dispatchMany`.
 */
export function isDispatchable(item: DispatchFields): boolean {
  return (
    item.flow === Flow.Paqueteria &&
    item.readyForRouteCount > 0 &&
    (item.status === ProformaStatus.Pagada || dispatchesUnpaid(item))
  );
}

/**
 * Texto del resultado de enviar a ruta: lo que salio, lo que salio SIN pagar
 * (aparte, como advertencia: no es un envio normal) y lo que no salio y por que.
 */
export function dispatchSummary(result: DispatchProformasResult): {
  ok: string | null;
  unpaid: string | null;
  failed: string | null;
} {
  const unpaidOnes = result.dispatched.filter((d) => d.unpaid);
  const unpaid =
    unpaidOnes.length === 0
      ? null
      : `Salieron a ruta SIN el pago confirmado (cliente exento de la retención por pago): ${unpaidOnes
          .map((d) => `proforma ${d.number}`)
          .join(', ')}. El cobro sigue pendiente.`;
  const moved = result.dispatched.reduce((n, d) => n + d.shipmentCodes.length, 0);
  const ok =
    result.dispatched.length === 0
      ? null
      : `En ruta de entrega: ${moved} ${moved === 1 ? 'paquete' : 'paquetes'} (${result.dispatched
          .map((d) => `proforma ${d.number}`)
          .join(', ')}).`;
  const failed =
    result.failed.length === 0
      ? null
      : result.failed
          .map((f) => `${f.shipmentCode ? `${f.shipmentCode} (proforma ${f.number})` : `Proforma ${f.number ?? ''}`}: ${f.message}`)
          .join(' ');
  return { ok, unpaid, failed };
}

/** Abre el documento de la proforma (vista previa si es borrador) en otra pestaña. */
export function openProformaDocument(id: string): void {
  window.open(`${API_BASE}/api/proformas/${id}/document`, '_blank');
}

export function ProformasScreen({
  role,
  initialStatus,
}: {
  role: Role;
  /** Estado de arranque (lo fija el Resumen al llegar desde un cuadro). */
  initialStatus?: ProformaStatus;
}) {
  const canManage = can(role, Permission.ProformasManage);
  /** Sacar a ruta es el permiso de despacho (Administrador, Operativo y Mensajeria). */
  const canDispatch = can(role, Permission.DeliveryDispatch);
  // Quien arma proformas arranca en los borradores; quien solo reparte, en las pagadas.
  const [status, setStatus] = useState<ProformaStatus | ''>(
    initialStatus ?? (canManage ? ProformaStatus.Borrador : canDispatch ? ProformaStatus.Pagada : ''),
  );
  const [flow, setFlow] = useState<Flow | ''>('');
  const [q, setQ] = useState('');
  /** Rango de dias (YYYY-MM-DD, calendario local) sobre la columna "Fecha". */
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  /**
   * Lo marcado, con su fila. Se guarda la FILA y no solo el id para que la
   * seleccion sobreviva a una busqueda o a un cambio de pagina: antes se cruzaba
   * contra lo que estaba a la vista, y lo marcado en otra pagina (o antes de
   * buscar otra proforma) se perdia sin aviso al aprobar.
   */
  const [selected, setSelected] = useState<Map<string, ProformaListItem>>(new Map());
  const [opened, setOpened] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = usePagedList<ProformaListItem>(
    '/proformas',
    {
      status: status || undefined,
      flow: flow || undefined,
      q: q.trim() || undefined,
      // El usuario elige dias en su hora local; el rango viaja como instantes UTC.
      from: from ? startOfLocalDayUtc(from) : undefined,
      to: to ? startOfNextLocalDayUtc(to) : undefined,
    },
    { errorMessage: 'No se pudieron cargar las proformas.' },
  );
  const { error, setError } = list;

  /**
   * Se marcan las que admiten una accion en bloque: los borradores (aprobar) y
   * las pagadas con paquetes en bodega (enviar a ruta), segun los permisos. Las
   * aprobadas de un casillero exento tambien salen a ruta, con aviso.
   */
  const isSelectable = (i: ProformaListItem) =>
    (canManage && i.status === ProformaStatus.Borrador) || (canDispatch && isDispatchable(i));
  const selectable = list.items.filter(isSelectable);
  const allSelected = selectable.length > 0 && selectable.every((i) => selected.has(i.id));
  const selectedDrafts = [...selected.values()].filter((i) => i.status === ProformaStatus.Borrador);
  const selectedDispatch = [...selected.values()].filter(isDispatchable);

  function toggle(row: ProformaListItem) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row);
      return next;
    });
  }

  /** Marca o desmarca las de ESTA pagina, sin tocar lo marcado en otras. */
  function toggleAll() {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const row of selectable) {
        if (allSelected) next.delete(row.id);
        else next.set(row.id, row);
      }
      return next;
    });
  }

  /**
   * Aprobacion en bloque. Cada proforma se aprueba por su cuenta: la respuesta
   * dice cuales salieron (con su numero) y por que no salio el resto, y eso es lo
   * que se le enseña al operador en vez de un "listo" que esconda los fallos.
   */
  async function approveSelected() {
    const ids = selectedDrafts.map((i) => i.id);
    if (ids.length === 0) return;
    if (!window.confirm(`Se aprobarán ${ids.length} proformas y se les asignará número. ¿Continuar?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<ApproveProformasResult>('/proformas/approve', { ids });
      const ok = result.approved.map((a) => a.number).join(', ');
      const failed = result.failed.map((f) => f.message).join(' ');
      if (result.approved.length > 0) setNotice(`Aprobadas: ${ok}.`);
      if (result.failed.length > 0) setError(`No se aprobaron ${result.failed.length}: ${failed}`);
      setSelected(new Map());
      list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron aprobar las proformas.');
    } finally {
      setBusy(false);
    }
  }

  /** Enviar a ruta en bloque: cada paquete avanza por su cuenta y se informa lo que no salio. */
  async function dispatchSelected() {
    const ids = selectedDispatch.map((i) => i.id);
    if (ids.length === 0) return;
    const count = selectedDispatch.reduce((n, i) => n + i.readyForRouteCount, 0);
    const unpaid = selectedDispatch.filter(dispatchesUnpaid).length;
    const unpaidWarning =
      unpaid === 0
        ? ''
        : `\n\nATENCIÓN: ${unpaid} ${unpaid === 1 ? 'proforma no está pagada' : 'proformas no están pagadas'}. ` +
          'Salen igual porque el cliente está exento de la retención por pago; el cobro queda pendiente.';
    if (!window.confirm(`Se enviarán a ruta de entrega ${count} paquetes de ${ids.length} proformas.${unpaidWarning}\n\n¿Continuar?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const summary = dispatchSummary(await api.post<DispatchProformasResult>('/proformas/dispatch', { ids }));
      if (summary.ok) setNotice(summary.ok);
      if (summary.unpaid) setWarning(summary.unpaid);
      if (summary.failed) setError(`No salieron: ${summary.failed}`);
      setSelected(new Map());
      list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron enviar a ruta.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Los REPORTES del filtro que se esta viendo (estado, tipo, fechas y busqueda): el
   * listado en CSV, el lote de documentos para imprimir y ese mismo lote en
   * Excel con el formato del documento. Se abren en otra
   * pestaña: la cookie de sesion viaja igual por ser el mismo origen.
   */
  function openReport(path: 'export.csv' | 'documents' | 'documents.xlsx') {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (flow) params.set('flow', flow);
    if (q.trim()) params.set('q', q.trim());
    if (from) params.set('from', startOfLocalDayUtc(from));
    if (to) params.set('to', startOfNextLocalDayUtc(to));
    window.open(`${API_BASE}/api/proformas/${path}?${params.toString()}`, '_blank');
  }

  const chips: FilterChip[] = [
    ...(status ? [{ label: `Estado: ${PROFORMA_STATUS_LABELS[status]}`, onClear: () => setStatus('') }] : []),
    ...(flow ? [{ label: `Tipo: ${FLOW_LABELS[flow]}`, onClear: () => setFlow('') }] : []),
    ...(from ? [{ label: `Desde: ${formatDayInput(from)}`, onClear: () => setFrom('') }] : []),
    ...(to ? [{ label: `Hasta: ${formatDayInput(to)}`, onClear: () => setTo('') }] : []),
  ];

  const canSelect = canManage || canDispatch;
  const columnCount = canSelect ? 10 : 9;

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Proformas</div>
          {list.data && <div className="count">{list.total.toLocaleString('es-CR')} proformas</div>}
        </div>
        <div className="actions">
          <button
            type="button" className="btn btn-ghost" disabled={list.total === 0}
            title="Listado de las proformas del filtro, en CSV para la hoja de cálculo"
            onClick={() => openReport('export.csv')}
          >
            Exportar listado
          </button>
          <button
            type="button" className="btn btn-ghost" disabled={list.total === 0}
            title="Todas las proformas del filtro en un documento, una por página, para imprimir o guardar como PDF"
            onClick={() => openReport('documents')}
          >
            Imprimir todas
          </button>
          <button
            type="button" className="btn btn-ghost" disabled={list.total === 0}
            title="Todas las proformas del filtro en Excel, una hoja por proforma con el formato del documento"
            onClick={() => openReport('documents.xlsx')}
          >
            Excel de todas
          </button>
          {canSelect && (
            <>
            {canDispatch && (
              <button
                type="button"
                className={canManage ? 'btn' : 'btn btn-primary'}
                disabled={busy || selectedDispatch.length === 0}
                onClick={() => void dispatchSelected()}
              >
                {`Enviar a ruta (${selectedDispatch.length})`}
              </button>
            )}
            {canManage && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || selectedDrafts.length === 0}
                onClick={() => void approveSelected()}
              >
                {busy ? 'Procesando…' : `Aprobar seleccionadas (${selectedDrafts.length})`}
              </button>
            )}
            </>
          )}
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}
      {warning && <div className="banner warn" style={{ marginBottom: 14 }}>{warning}</div>}

      <FilterBar
        search={{ value: q, onChange: setQ, placeholder: 'Buscar por número de proforma, factura electrónica, casillero o cliente…' }}
        chips={chips}
        onClearAll={() => {
          setStatus('');
          setFlow('');
          setFrom('');
          setTo('');
        }}
      >
        <div>
          <label className="field-label" htmlFor="pf-status">Estado</label>
          <select
            id="pf-status" className="input" value={status}
            onChange={(e) => {
              setStatus(e.target.value as ProformaStatus | '');
              setSelected(new Map());
            }}
          >
            <option value="">Todos</option>
            {Object.values(ProformaStatus).map((s) => (
              <option key={s} value={s}>{PROFORMA_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="pf-flow">Tipo de trámite</label>
          <select id="pf-flow" className="input" value={flow} onChange={(e) => setFlow(e.target.value as Flow | '')}>
            <option value="">Todos</option>
            {Object.values(Flow).map((f) => (
              <option key={f} value={f}>{FLOW_LABELS[f]}</option>
            ))}
          </select>
        </div>
        <div className="field-pair">
          <div>
            <label className="field-label" htmlFor="pf-from">Desde</label>
            <input id="pf-from" className="input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="pf-to">Hasta</label>
            <input id="pf-to" className="input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </FilterBar>

      <ListBody refreshing={list.refreshing}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {canSelect && (
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      aria-label="Marcar todas las que admiten una acción"
                      checked={allSelected}
                      disabled={selectable.length === 0}
                      onChange={toggleAll}
                    />
                  </th>
                )}
                <th>Proforma</th>
                <th>Factura electrónica</th>
                <th>Cliente</th>
                <th>Tipo</th>
                <th>Estado</th>
                <th>Trámites</th>
                <th>Total</th>
                <th>Fecha</th>
                <th style={{ textAlign: 'right' }}>Acciones</th>
              </tr>
            </thead>
            {list.loading && <TableSkeleton cols={columnCount} />}
            <tbody>
              {list.items.map((row) => (
                <tr key={row.id}>
                  {canSelect && (
                    <td>
                      {isSelectable(row) && (
                        <input
                          type="checkbox"
                          aria-label={`Marcar la proforma de ${row.client.name}`}
                          checked={selected.has(row.id)}
                          onChange={() => toggle(row)}
                        />
                      )}
                    </td>
                  )}
                  <td>
                    <span className="mono">{row.number ?? 'Sin número'}</span>
                  </td>
                  <td>
                    {row.electronicInvoiceNumber
                      ? <span className="mono">{row.electronicInvoiceNumber}</span>
                      : <span className="muted">-</span>}
                  </td>
                  <td>
                    <div className="cell-name">{row.client.name}</div>
                    <span className="mono muted">{row.client.code}</span>
                  </td>
                  <td>{FLOW_LABELS[row.flow]}</td>
                  <td>
                    <span className={proformaStatusPill(row.status)}>
                      <span className="dot" />
                      {PROFORMA_STATUS_LABELS[row.status]}
                    </span>
                    {row.status !== ProformaStatus.Borrador && (
                      <div className="cell-sub">{PROFORMA_DELIVERY_STATUS_LABELS[row.deliveryStatus]}</div>
                    )}
                    {isDispatchable(row) && (
                      <div className="cell-sub">
                        {row.readyForRouteCount} en bodega para salir a ruta
                      </div>
                    )}
                    {isDispatchable(row) && dispatchesUnpaid(row) && (
                      <div className="cell-sub" style={{ color: 'var(--warn)', fontWeight: 600 }}>
                        Sin pagar: sale a ruta por exención del cliente
                      </div>
                    )}
                  </td>
                  <td>{row.shipmentCount}</td>
                  <td>
                    {proformaTotal(row)}
                    {row.status === ProformaStatus.Borrador && <div className="cell-sub">Vista previa</div>}
                  </td>
                  <td>{formatDate(row.approvedAt ?? row.createdAt)}</td>
                  <td>
                    <div className="actions">
                      <IconButton label="Ver detalle" icon="eye" onClick={() => setOpened(row.id)} />
                      <IconButton
                        label={row.status === ProformaStatus.Borrador ? 'Vista previa' : 'Ver documento'}
                        icon="file"
                        onClick={() => openProformaDocument(row.id)}
                      />
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
          noun="proformas"
        />
      </ListBody>

      <EmptyList loading={list.loading} empty={list.items.length === 0}>
        {status === ProformaStatus.Borrador
          ? 'No hay borradores por revisar.'
          : 'No hay proformas con ese filtro.'}
      </EmptyList>

      {opened && (
        <ProformaDetailModal
          id={opened}
          role={role}
          onClose={() => {
            setOpened(null);
            list.reload();
          }}
          onOpen={(id) => setOpened(id)}
        />
      )}
    </div>
  );
}
