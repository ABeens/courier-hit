/**
 * Pantalla "Proformas" (permiso proformas.read; operar pide proformas.manage).
 * Especificacion: docs/proformas-cambios.html.
 *
 * Es la bandeja del modulo: los borradores que arma el sistema al recibir los
 * paquetes, las proformas aprobadas esperando pago y las pagadas. Desde aqui se
 * aprueba (una o varias a la vez) y se entra al detalle, donde se ajusta el
 * borrador, se corrige una aprobada o se registra un deposito.
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
import type { ApproveProformasResult, ProformaListItem, Role } from '@courier/shared';
import { FilterBar } from '../components/FilterBar';
import type { FilterChip } from '../components/FilterBar';
import { IconButton } from '../components/IconButton';
import { EmptyList, ListBody, TableSkeleton } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { API_BASE, ApiError, api } from '../lib/api';
import { formatDate } from '../lib/datetime';
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

/** Abre el documento de la proforma (vista previa si es borrador) en otra pestaña. */
export function openProformaDocument(id: string): void {
  window.open(`${API_BASE}/api/proformas/${id}/document`, '_blank');
}

export function ProformasScreen({
  role,
  initialStatus = ProformaStatus.Borrador,
}: {
  role: Role;
  /** Estado de arranque (lo fija el Resumen al llegar desde un cuadro). */
  initialStatus?: ProformaStatus;
}) {
  const canManage = can(role, Permission.ProformasManage);
  const [status, setStatus] = useState<ProformaStatus | ''>(initialStatus);
  const [flow, setFlow] = useState<Flow | ''>('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = usePagedList<ProformaListItem>(
    '/proformas',
    { status: status || undefined, flow: flow || undefined, q: q.trim() || undefined },
    { errorMessage: 'No se pudieron cargar las proformas.' },
  );
  const { error, setError } = list;

  /** Solo los borradores se aprueban: son los unicos que se pueden marcar. */
  const selectable = list.items.filter((i) => i.status === ProformaStatus.Borrador);
  const allSelected = selectable.length > 0 && selectable.every((i) => selected.has(i.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((i) => i.id)));
  }

  /**
   * Aprobacion en bloque. Cada proforma se aprueba por su cuenta: la respuesta
   * dice cuales salieron (con su numero) y por que no salio el resto, y eso es lo
   * que se le enseña al operador en vez de un "listo" que esconda los fallos.
   */
  async function approveSelected() {
    const ids = [...selected];
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
      setSelected(new Set());
      list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron aprobar las proformas.');
    } finally {
      setBusy(false);
    }
  }

  const chips: FilterChip[] = [
    ...(status ? [{ label: `Estado: ${PROFORMA_STATUS_LABELS[status]}`, onClear: () => setStatus('') }] : []),
    ...(flow ? [{ label: `Tipo: ${FLOW_LABELS[flow]}`, onClear: () => setFlow('') }] : []),
  ];

  const columnCount = canManage ? 9 : 8;

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Proformas</div>
          {list.data && <div className="count">{list.total.toLocaleString('es-CR')} proformas</div>}
        </div>
        {canManage && (
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || selected.size === 0}
              onClick={() => void approveSelected()}
            >
              {busy ? 'Aprobando…' : `Aprobar seleccionadas (${selected.size})`}
            </button>
          </div>
        )}
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <FilterBar
        search={{ value: q, onChange: setQ, placeholder: 'Buscar por número de proforma, casillero o cliente…' }}
        chips={chips}
        onClearAll={() => {
          setStatus('');
          setFlow('');
        }}
      >
        <div>
          <label className="field-label" htmlFor="pf-status">Estado</label>
          <select
            id="pf-status" className="input" value={status}
            onChange={(e) => {
              setStatus(e.target.value as ProformaStatus | '');
              setSelected(new Set());
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
      </FilterBar>

      <ListBody refreshing={list.refreshing}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {canManage && (
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      aria-label="Marcar todos los borradores"
                      checked={allSelected}
                      disabled={selectable.length === 0}
                      onChange={toggleAll}
                    />
                  </th>
                )}
                <th>Proforma</th>
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
                  {canManage && (
                    <td>
                      {row.status === ProformaStatus.Borrador && (
                        <input
                          type="checkbox"
                          aria-label={`Marcar la proforma de ${row.client.name}`}
                          checked={selected.has(row.id)}
                          onChange={() => toggle(row.id)}
                        />
                      )}
                    </td>
                  )}
                  <td>
                    <span className="mono">{row.number ?? 'Sin número'}</span>
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
