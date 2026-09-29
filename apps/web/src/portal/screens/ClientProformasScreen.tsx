/**
 * Pantalla "Mis proformas" del cliente (permiso proformas.read.own).
 *
 * Es SOLO CONSULTA: las proformas propias ya emitidas (aprobadas, esperando pago,
 * y pagadas) con su total y el documento para ver o guardar como PDF. Los
 * borradores no aparecen: son trabajo interno del staff y la API ni los envia.
 *
 * No reusa la bandeja del staff (`ProformasScreen`): alla se aprueba, se envia a
 * ruta y se entra al detalle operativo, y nada de eso es del cliente.
 */
import { useState } from 'react';
import {
  FLOW_LABELS,
  Flow,
  PROFORMA_DELIVERY_STATUS_LABELS,
  PROFORMA_STATUS_LABELS,
  ProformaStatus,
} from '@courier/shared';
import type { ProformaListItem } from '@courier/shared';
import { FilterBar } from '../components/FilterBar';
import type { FilterChip } from '../components/FilterBar';
import { IconButton } from '../components/IconButton';
import { EmptyList, ListBody, TableSkeleton } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { formatDate } from '../lib/datetime';
import { usePagedList } from '../lib/usePagedList';
import { openProformaDocument, proformaStatusPill, proformaTotal } from './ProformasScreen';

/** Los estados que el cliente puede ver (el borrador no es suyo todavia). */
const CLIENT_STATUSES = [ProformaStatus.Aprobada, ProformaStatus.Pagada] as const;

export function ClientProformasScreen() {
  const [status, setStatus] = useState<ProformaStatus | ''>('');
  const [flow, setFlow] = useState<Flow | ''>('');
  const [q, setQ] = useState('');

  const list = usePagedList<ProformaListItem>(
    '/proformas/mine',
    { status: status || undefined, flow: flow || undefined, q: q.trim() || undefined },
    { errorMessage: 'No se pudieron cargar tus proformas.' },
  );

  const chips: FilterChip[] = [
    ...(status ? [{ label: `Estado: ${PROFORMA_STATUS_LABELS[status]}`, onClear: () => setStatus('') }] : []),
    ...(flow ? [{ label: `Tipo: ${FLOW_LABELS[flow]}`, onClear: () => setFlow('') }] : []),
  ];

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Mis proformas</div>
          {list.data && <div className="count">{list.total.toLocaleString('es-CR')} proformas</div>}
        </div>
      </div>

      {list.error && <div className="banner err" style={{ marginBottom: 14 }}>{list.error}</div>}

      <FilterBar
        search={{ value: q, onChange: setQ, placeholder: 'Buscar por número de proforma…' }}
        chips={chips}
        onClearAll={() => {
          setStatus('');
          setFlow('');
        }}
      >
        <div>
          <label className="field-label" htmlFor="cpf-status">Estado</label>
          <select
            id="cpf-status" className="input" value={status}
            onChange={(e) => setStatus(e.target.value as ProformaStatus | '')}
          >
            <option value="">Todos</option>
            {CLIENT_STATUSES.map((s) => (
              <option key={s} value={s}>{PROFORMA_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="cpf-flow">Tipo de trámite</label>
          <select id="cpf-flow" className="input" value={flow} onChange={(e) => setFlow(e.target.value as Flow | '')}>
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
                <th>Proforma</th>
                <th>Tipo</th>
                <th>Estado</th>
                <th>Trámites</th>
                <th>Total</th>
                <th>Fecha</th>
                <th style={{ textAlign: 'right' }}>Acciones</th>
              </tr>
            </thead>
            {list.loading && <TableSkeleton cols={7} />}
            <tbody>
              {list.items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className="mono">{row.number}</span>
                  </td>
                  <td>{FLOW_LABELS[row.flow]}</td>
                  <td>
                    <span className={proformaStatusPill(row.status)}>
                      <span className="dot" />
                      {PROFORMA_STATUS_LABELS[row.status]}
                    </span>
                    <div className="cell-sub">{PROFORMA_DELIVERY_STATUS_LABELS[row.deliveryStatus]}</div>
                  </td>
                  <td>{row.shipmentCount}</td>
                  <td>{proformaTotal(row)}</td>
                  <td>{formatDate(row.approvedAt ?? row.createdAt)}</td>
                  <td>
                    <div className="actions">
                      <IconButton label="Ver documento" icon="file" onClick={() => openProformaDocument(row.id)} />
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
        {status || flow || q.trim() ? 'No hay proformas con ese filtro.' : 'Todavía no tienes proformas emitidas.'}
      </EmptyList>
    </div>
  );
}
