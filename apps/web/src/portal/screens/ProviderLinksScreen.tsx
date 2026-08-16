/**
 * Pantalla "Enlace con el operador de Miami" (permiso config.manage, solo Admin).
 *
 * Existe por un problema muy concreto: con la integración encendida, un cliente
 * cuyo casillero no quedó `synced` **no puede entrar al portal**. El robot
 * reintenta cada hora, pero hay rechazos que ningún reintento arregla (el típico
 * es el nombre duplicado, porque el proveedor exige nombre único en la cuenta).
 * Sin esta pantalla ese cliente queda encerrado y nadie puede ver por qué.
 *
 * Por eso el listado arranca mostrando **solo los casos con problema**: los
 * casilleros sanos no generan trabajo, y mezclarlos escondería los pocos que sí.
 */
import { useState } from 'react';
import {
  HELGA_SYNC_STATUS_LABELS,
  HelgaSyncStatus,
  PROVIDER_LINK_SOURCE_LABELS,
} from '@courier/shared';
import type { ProviderLinkDetailDto, ProviderLinkDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { usePagedList } from '../lib/usePagedList';
import { FilterBar } from '../components/FilterBar';
import { CardsSkeleton, EmptyList, ListBody } from '../components/ListLoading';
import { ModalOverlay } from '../components/ModalOverlay';
import { Pagination } from '../components/Pagination';
import { ProviderLinkEditModal } from './ProviderLinkEditModal';

/**
 * Tono de la ficha. El rechazado va en `danger` porque pide una decisión humana;
 * el que está en proceso va en `warn` porque el robot todavía puede resolverlo
 * solo.
 */
const LINK_TONE: Record<HelgaSyncStatus, 'danger' | 'warn' | 'ok'> = {
  [HelgaSyncStatus.Failed]: 'danger',
  [HelgaSyncStatus.Pending]: 'warn',
  [HelgaSyncStatus.Synced]: 'ok',
};

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  const isEmpty = value == null || value === '';
  const classes = [mono && !isEmpty ? 'mono' : '', isEmpty ? 'empty-val' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="card-item-field">
      <dt>{label}</dt>
      <dd className={classes || undefined}>{isEmpty ? '—' : value}</dd>
    </div>
  );
}

/** Fecha en hora local del usuario; en UTC se guarda, aquí solo se muestra. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-CR', { dateStyle: 'short', timeStyle: 'short' });
}

export function ProviderLinksScreen() {
  const [status, setStatus] = useState<HelgaSyncStatus | ''>('');
  const [q, setQ] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProviderLinkDetailDto | null>(null);
  const [editing, setEditing] = useState<ProviderLinkDto | null>(null);

  /**
   * El listado, paginado. `blockedCount` llega con la respuesta y lo cuenta el
   * servidor sobre el filtro completo: contando la pagina, un panel con treinta
   * clientes encerrados fuera del portal diria tres, que es el numero que
   * justifica la pantalla entera.
   */
  const list = usePagedList<ProviderLinkDto, { blockedCount: number }>(
    '/clients/provider-links',
    { status: status || undefined, q: q.trim() || undefined },
    { errorMessage: 'No se pudo cargar el listado.' },
  );
  const { error, setError, reload: load } = list;

  /** Abre la bitácora de un casillero. Se pide al abrir: puede ser larga. */
  async function openDetail(clientId: string) {
    try {
      setDetail(await api.get<ProviderLinkDetailDto>(`/clients/${clientId}/provider-link`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar la bitácora.');
    }
  }

  const blocked = list.data?.blockedCount ?? 0;

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Enlace con el operador de Miami</div>
          {list.data && (
            <div className="count">
              {list.total.toLocaleString('es-CR')} casilleros
              {blocked > 0 && ` · ${blocked.toLocaleString('es-CR')} sin poder ingresar al portal`}
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
          placeholder: 'Buscar por casillero, nombre, cédula o correo…',
        }}
        /* El valor por defecto de "Enlace" NO es "todos" sino la cola de trabajo
           (lo que falta por enlazar), asi que solo pinta ficha cuando se sale de
           ella: es entonces cuando el listado deja de ser lo que se espera. */
        chips={
          status
            ? [{
                label: `Enlace: Solo ${HELGA_SYNC_STATUS_LABELS[status].toLowerCase()}`,
                onClear: () => setStatus(''),
              }]
            : []
        }
        onClearAll={() => setStatus('')}
      >
        <div>
          <label className="field-label" htmlFor="f-link-status">Enlace</label>
          <select
            id="f-link-status"
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as HelgaSyncStatus | '')}
          >
            <option value="">Sin enlazar (en proceso y rechazados)</option>
            {Object.values(HelgaSyncStatus).map((s) => (
              <option key={s} value={s}>
                Solo {HELGA_SYNC_STATUS_LABELS[s].toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      </FilterBar>

      {list.loading && <CardsSkeleton rows={3} />}

      <ListBody refreshing={list.refreshing}>
        <div className="cards">
        {list.items.map((row) => (
          <article className={`card-item tone-${LINK_TONE[row.status]}`} key={row.clientId}>
            <div className="card-item-head">
              <div className="card-item-ident">
                <span className="card-item-code">{row.clientCode}</span>
                <div className="card-item-title">{row.name}</div>
                <div className="card-item-sub">
                  <span className="sub-type">Cédula {row.idNumber}</span>
                  <span className="sub-date">Registrado {formatDate(row.createdAt)}</span>
                </div>
              </div>
              <div className="card-item-aside">
                <span className="spill">
                  <span className="dot" />
                  {HELGA_SYNC_STATUS_LABELS[row.status]}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => void openDetail(row.clientId)}>
                  Bitácora
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setEditing(row)}>
                  Corregir
                </button>
              </div>
            </div>

            {row.blocksLogin && (
              <div className="banner err" style={{ margin: '0 0 10px' }}>
                Este cliente <strong>no puede ingresar al portal</strong> hasta que el
                casillero quede enlazado.
              </div>
            )}

            <div className="card-item-body">
              <section className="card-sec">
                <div className="card-sec-title">Enlace</div>
                <dl className="card-sec-fields">
                  <Field label="Id en el operador" value={row.helgaClientId} mono />
                  <Field label="Sub-casillero" value={row.subLocker} mono />
                  <Field label="Enlazado el" value={row.syncedAt ? formatDate(row.syncedAt) : null} />
                </dl>
              </section>
              <section className="card-sec">
                <div className="card-sec-title">Diagnóstico</div>
                <dl className="card-sec-fields">
                  <Field label="Intentos" value={String(row.attempts)} />
                  <Field label="Último error" value={row.lastError} />
                  <Field label="Correo" value={row.email} />
                </dl>
              </section>
            </div>
          </article>
        ))}
        </div>

        <Pagination
          page={list.page}
          pageSize={list.pageSize}
          total={list.total}
          totalPages={list.totalPages}
          onPage={list.goToPage}
          busy={list.refreshing}
          noun="casilleros"
        />
      </ListBody>

      <EmptyList loading={list.loading} empty={list.items.length === 0}>
        {status || q
          ? 'No hay casilleros que coincidan.'
          : 'Todos los casilleros están enlazados.'}
      </EmptyList>

      {detail && (
        <ProviderLinkHistory detail={detail} onClose={() => setDetail(null)} />
      )}

      {editing && (
        <ProviderLinkEditModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
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

/**
 * Bitácora del enlace. Muestra los tres orígenes juntos (registro, reintento del
 * robot y corrección manual) porque la pregunta que responde es "qué le pasó a
 * este casillero", no "qué hizo cada actor".
 */
function ProviderLinkHistory({
  detail,
  onClose,
}: {
  detail: ProviderLinkDetailDto;
  onClose: () => void;
}) {
  return (
    <ModalOverlay onClose={onClose}>
      <div className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Bitácora del enlace</h3>
          <p>
            {detail.link.clientCode} · {detail.link.name}
          </p>
        </div>

        <div className="modal-body">
          {detail.events.length === 0 ? (
            <div className="empty">Sin eventos registrados todavía.</div>
          ) : (
            <ol className="link-log">
              {detail.events.map((ev) => (
                <li key={ev.id} className={`link-log-item tone-${LINK_TONE[ev.status]}`}>
                  <div className="link-log-head">
                    <strong>{PROVIDER_LINK_SOURCE_LABELS[ev.source]}</strong>
                    <span className="spill">
                      <span className="dot" />
                      {HELGA_SYNC_STATUS_LABELS[ev.status]}
                    </span>
                    <span className="sub-date">{formatDate(ev.createdAt)}</span>
                  </div>

                  {ev.detail && <p className="link-log-detail">{ev.detail}</p>}

                  {ev.changes && Object.keys(ev.changes).length > 0 && (
                    <ul className="link-log-changes">
                      {Object.entries(ev.changes).map(([field, change]) => (
                        <li key={field}>
                          <span className="mono">{field}</span>{' '}
                          <span className="empty-val">{change.from ?? '—'}</span> →{' '}
                          <span className="mono">{change.to ?? '—'}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="sub-type">{ev.createdByName ?? 'Robot (tarea automática)'}</div>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
