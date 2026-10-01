/**
 * Pantalla "Auditoría" (permiso audit.read, solo admin).
 *
 * Es SOLO CONSULTA: el registro de las correcciones administrativas hechas sobre
 * los trámites (estado corregido, proforma devuelta a borrador, cambio de dueño,
 * descartes y altas sin dueño), cada una con el comentario obligatorio con que
 * se hizo, quién la hizo y cuándo. Las correcciones se hacen en su pantalla;
 * aquí solo se revisan.
 */
import { useState } from 'react';
import { CORRECTION_KIND_LABELS, CorrectionKind, SHIPMENT_TYPE_LABELS, STATE_LABELS } from '@courier/shared';
import type { CorrectionDto } from '@courier/shared';
import { FilterBar } from '../components/FilterBar';
import type { FilterChip } from '../components/FilterBar';
import { EmptyList, ListBody, TableSkeleton } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { formatDateTime, formatDayInput, startOfLocalDayUtc, startOfNextLocalDayUtc } from '../lib/datetime';
import { usePagedList } from '../lib/usePagedList';

export function AuditScreen() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<CorrectionKind | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const list = usePagedList<CorrectionDto>(
    '/audit/corrections',
    {
      q: q.trim() || undefined,
      kind: kind || undefined,
      from: from ? startOfLocalDayUtc(from) : undefined,
      to: to ? startOfNextLocalDayUtc(to) : undefined,
    },
    { errorMessage: 'No se pudo cargar la auditoría.' },
  );

  const chips: FilterChip[] = [
    ...(kind ? [{ label: `Tipo: ${CORRECTION_KIND_LABELS[kind]}`, onClear: () => setKind('') }] : []),
    ...(from ? [{ label: `Desde: ${formatDayInput(from)}`, onClear: () => setFrom('') }] : []),
    ...(to ? [{ label: `Hasta: ${formatDayInput(to)}`, onClear: () => setTo('') }] : []),
  ];
  const filtered = Boolean(kind || from || to || q.trim());

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Auditoría</div>
          {list.data && <div className="count">{list.total.toLocaleString('es-CR')} correcciones</div>}
        </div>
      </div>

      {list.error && <div className="banner err" style={{ marginBottom: 14 }}>{list.error}</div>}

      <FilterBar
        search={{ value: q, onChange: setQ, placeholder: 'Buscar por comentario, trámite, tracking, casillero o usuario…' }}
        chips={chips}
        onClearAll={() => {
          setKind('');
          setFrom('');
          setTo('');
        }}
      >
        <div>
          <label className="field-label" htmlFor="au-kind">Tipo de corrección</label>
          <select id="au-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as CorrectionKind | '')}>
            <option value="">Todos</option>
            {Object.values(CorrectionKind).map((k) => (
              <option key={k} value={k}>{CORRECTION_KIND_LABELS[k]}</option>
            ))}
          </select>
        </div>
        <div className="field-pair">
          <div>
            <label className="field-label" htmlFor="au-from">Desde</label>
            <input id="au-from" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="au-to">Hasta</label>
            <input id="au-to" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </FilterBar>

      <ListBody refreshing={list.refreshing}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Trámite</th>
                <th>Estado</th>
                <th>Comentario</th>
                <th>Corregido por</th>
              </tr>
            </thead>
            {list.loading && <TableSkeleton cols={6} />}
            <tbody>
              {list.items.map((row) => (
                <tr key={row.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.createdAt)}</td>
                  <td>{CORRECTION_KIND_LABELS[row.kind]}</td>
                  <td>
                    <span className="mono">{row.shipmentCode}</span>
                    <div className="cell-sub">
                      {SHIPMENT_TYPE_LABELS[row.shipmentType]} · <span className="mono">{row.tracking}</span>
                    </div>
                    <div className="cell-sub">
                      {row.clientCode ? `${row.clientCode} (${row.clientName ?? ''})` : 'Sin dueño'}
                    </div>
                  </td>
                  <td>
                    {/* Las enmiendas de dueño o descarte no mueven el estado: se
                        dice una sola vez en vez de "de X a X". */}
                    {row.previousState && row.previousState !== row.state ? (
                      <>
                        <div className="cell-sub">{STATE_LABELS[row.previousState]} →</div>
                        <div>{STATE_LABELS[row.state]}</div>
                      </>
                    ) : (
                      STATE_LABELS[row.state]
                    )}
                  </td>
                  <td style={{ whiteSpace: 'pre-wrap', minWidth: 260 }}>{row.note}</td>
                  <td>{row.authorName ?? <span className="muted">Usuario eliminado</span>}</td>
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
          noun="correcciones"
        />
      </ListBody>

      <EmptyList loading={list.loading} empty={list.items.length === 0}>
        {filtered ? 'No hay correcciones con ese filtro.' : 'Todavía no se ha hecho ninguna corrección.'}
      </EmptyList>
    </div>
  );
}
