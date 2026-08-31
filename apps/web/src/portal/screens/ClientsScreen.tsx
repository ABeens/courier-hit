/**
 * Pantalla "Clientes" (permiso clients.read) — Requerimientos Parte 3.
 *
 * Columnas del manual: nombre, cédula, teléfono, correo, provincia/cantón/
 * distrito, flag "Nuevo", tipo de tarifa y total de trámites.
 *
 * El flag "Nuevo" es la razón de ser de esta pantalla: marca los casilleros que
 * nadie ha revisado todavía. Por eso se destaca con un badge y se puede filtrar
 * por él: la lista completa sirve para consultar, pero la de nuevos es la que
 * genera trabajo.
 */
import { useState } from 'react';
import {
  ClientReviewStatus,
  Currency,
  UserStatus,
  findCanton,
  findDistrict,
  findProvince,
  formatMoney,
} from '@courier/shared';
import { IconButton } from '../components/IconButton';
import { FilterBar } from '../components/FilterBar';
import { CardsSkeleton, EmptyList, ListBody } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { ApiError, api } from '../lib/api';
import { usePagedList } from '../lib/usePagedList';
import { ClientEditModal } from './ClientEditModal';

export interface ClientRow {
  id: string;
  code: string;
  name: string;
  email: string;
  phone: string | null;
  idNumber: string;
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
  reviewStatus: ClientReviewStatus;
  /** Estado de la cuenta: `inactivo` es un casillero con el acceso bloqueado. */
  status: UserStatus;
  clientRateName: string | null;
  clientRateId: string | null;
  creditLimit: number | null;
  creditLimitCurrency: Currency | null;
  shipmentCount: number;
}

/**
 * Par etiqueta/valor de la ficha (mismo componente que en Paquetería). `empty`
 * cambia el "—" por un texto propio cuando la ausencia tiene nombre ("Sin
 * tarifa"), pero conserva el tono tenue de un campo vacío.
 */
function Field({
  label,
  value,
  mono,
  empty,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  empty?: string;
}) {
  const isEmpty = value == null;
  const classes = [mono && !isEmpty ? 'mono' : '', isEmpty ? 'empty-val' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="card-item-field">
      <dt>{label}</dt>
      <dd className={classes || undefined}>{value ?? empty ?? '—'}</dd>
    </div>
  );
}

/**
 * Tono de la ficha por estado de revisión: un casillero nuevo pide atención
 * (warn), uno ya revisado descansa en neutro. `--tone` tiñe la píldora igual
 * que en Paquetería.
 */
const CLIENT_TONE: Record<ClientReviewStatus, 'warn' | 'neutral'> = {
  [ClientReviewStatus.Nuevo]: 'warn',
  [ClientReviewStatus.Revisado]: 'neutral',
};
const CLIENT_STATUS_LABEL: Record<ClientReviewStatus, string> = {
  [ClientReviewStatus.Nuevo]: 'Nuevo',
  [ClientReviewStatus.Revisado]: 'Revisado',
};

export function ClientsScreen({
  canWrite,
  canSuspend,
}: {
  canWrite: boolean;
  /** Permiso `clients.suspend`: bloquear o reactivar el acceso del titular. */
  canSuspend: boolean;
}) {
  const [q, setQ] = useState('');
  const [onlyNew, setOnlyNew] = useState(false);
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ClientRow | null>(null);

  /**
   * Los DOS filtros van a la API. El de "nuevos" se resolvia antes en el
   * navegador, con el argumento de que era un subconjunto de lo ya cargado y no
   * debia costar un viaje: eso dejo de ser cierto al paginar, porque entonces
   * filtraria solo las cincuenta filas visibles y esconderia el resto de la cola,
   * que es justo la que genera el trabajo de esta pantalla.
   *
   * `pendingReview` viene con la respuesta y se cuenta en el servidor sobre TODOS
   * los casilleros de la busqueda, no sobre la pagina.
   */
  const list = usePagedList<ClientRow, { pendingReview: number }>(
    '/clients',
    {
      q: q.trim() || undefined,
      reviewStatus: onlyNew ? ClientReviewStatus.Nuevo : undefined,
      status: status || undefined,
    },
    { errorMessage: 'No se pudo cargar el listado.' },
  );
  const { error, setError, reload: load } = list;

  /**
   * Bloquea o reactiva el acceso del titular. Se confirma antes porque no es una
   * edicion: al bloquear, el cliente pierde el portal y sus llaves de API dejan
   * de responder en la siguiente peticion, y quien lo pulsa por error no tiene
   * forma de notarlo desde esta pantalla.
   */
  async function toggleAccess(row: ClientRow) {
    const blocking = row.status === UserStatus.Activo;
    const next = blocking ? UserStatus.Inactivo : UserStatus.Activo;
    const confirmed = window.confirm(
      blocking
        ? `¿Bloquear el acceso de ${row.name} (${row.code})? No podrá entrar al portal, se cerrará su sesión y sus llaves de API dejarán de funcionar. Sus trámites y su historial se conservan.`
        : `¿Reactivar el acceso de ${row.name} (${row.code})? Volverá a entrar al portal con sus llaves de API de siempre.`,
    );
    if (!confirmed) return;

    setError(null);
    setNotice(null);
    try {
      await api.patch(`/clients/${row.id}/status`, { status: next });
      setNotice(`${row.name}: acceso ${blocking ? 'bloqueado' : 'reactivado'}.`);
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cambiar el acceso.');
    }
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Clientes</div>
          {list.data && (
            <div className="count">
              {list.total.toLocaleString('es-CR')} casilleros ·{' '}
              {list.data.pendingReview.toLocaleString('es-CR')} por revisar
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
          placeholder: 'Buscar por nombre, casillero, cédula o correo…',
        }}
        chips={[
          ...(onlyNew
            ? [{ label: 'Casilleros: Solo nuevos', onClear: () => setOnlyNew(false) }]
            : []),
          ...(status
            ? [{
                label: `Acceso: ${status === UserStatus.Activo ? 'Activo' : 'Bloqueado'}`,
                onClear: () => setStatus(''),
              }]
            : []),
        ]}
        onClearAll={() => {
          setOnlyNew(false);
          setStatus('');
        }}
      >
        <div>
          <label className="field-label" htmlFor="f-review">Revisión</label>
          <select
            id="f-review"
            className="input"
            value={onlyNew ? 'nuevos' : ''}
            onChange={(e) => setOnlyNew(e.target.value === 'nuevos')}
          >
            <option value="">Todos los casilleros</option>
            <option value="nuevos">Solo nuevos (por revisar)</option>
          </select>
        </div>

        {/* Eje distinto del de revisión: uno es trabajo pendiente, este es quién
            puede entrar. Un casillero bloqueado sigue pudiendo estar sin revisar. */}
        <div>
          <label className="field-label" htmlFor="f-access">Acceso</label>
          <select
            id="f-access"
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Todos los accesos</option>
            <option value={UserStatus.Activo}>Activo</option>
            <option value={UserStatus.Inactivo}>Bloqueado</option>
          </select>
        </div>
      </FilterBar>

      {list.loading && <CardsSkeleton />}

      <ListBody refreshing={list.refreshing}>
        <div className="cards">
        {list.items.map((row) => {
          const province = findProvince(row.provinceCode)?.name ?? null;
          const canton = findCanton(row.cantonCode)?.name ?? null;
          const district = findDistrict(row.districtCode)?.name ?? null;
          // Un monto sin moneda no significa nada (regla M2): si falta uno, se
          // trata como "Sin límite", no se inventa la cifra.
          const credit =
            row.creditLimit != null && row.creditLimitCurrency
              ? formatMoney(row.creditLimit, row.creditLimitCurrency)
              : null;
          const shipments = `${row.shipmentCount} ${row.shipmentCount === 1 ? 'trámite' : 'trámites'}`;
          // El acceso manda sobre la revisión al teñir la ficha: un casillero
          // bloqueado no está esperando que alguien lo mire, está fuera. Su
          // estado de revisión sigue accesible por el filtro.
          const blocked = row.status === UserStatus.Inactivo;
          const tone = blocked ? 'danger' : CLIENT_TONE[row.reviewStatus];
          return (
            <article className={`card-item tone-${tone}`} key={row.id}>
              <div className="card-item-head">
                <div className="card-item-ident">
                  <span className="card-item-code">{row.code}</span>
                  <div className="card-item-title">{row.name}</div>
                  <div className="card-item-sub">
                    <span className="sub-type">Cédula {row.idNumber}</span>
                    <span className="sub-date">{shipments}</span>
                  </div>
                </div>
                <div className="card-item-aside">
                  <span className="spill">
                    <span className="dot" />
                    {blocked ? 'Acceso bloqueado' : CLIENT_STATUS_LABEL[row.reviewStatus]}
                  </span>
                  {canWrite && <IconButton label="Editar cliente" icon="edit" onClick={() => setEditing(row)} />}
                  {canSuspend &&
                    (blocked ? (
                      <IconButton
                        label="Reactivar acceso"
                        icon="checkCircle"
                        onClick={() => void toggleAccess(row)}
                      />
                    ) : (
                      <IconButton
                        label="Bloquear acceso"
                        icon="ban"
                        tone="danger"
                        hint="Bloquear acceso (cierra el portal y sus llaves de API)"
                        onClick={() => void toggleAccess(row)}
                      />
                    ))}
                </div>
              </div>

              <div className="card-item-body">
                <section className="card-sec">
                  <div className="card-sec-title">Contacto</div>
                  <dl className="card-sec-fields">
                    <Field label="Teléfono" value={row.phone} mono />
                    <Field label="Correo" value={row.email} />
                  </dl>
                </section>
                <section className="card-sec">
                  <div className="card-sec-title">Dirección</div>
                  <dl className="card-sec-fields">
                    <Field label="Provincia" value={province} />
                    <Field label="Cantón" value={canton} />
                    <Field label="Distrito" value={district} />
                    <Field label="Señas" value={row.addressLine || null} />
                  </dl>
                </section>
                <section className="card-sec">
                  <div className="card-sec-title">Cuenta</div>
                  <dl className="card-sec-fields">
                    <Field label="Tarifa" value={row.clientRateName} empty="Sin tarifa" />
                    <Field label="Límite de crédito" value={credit} empty="Sin límite" />
                  </dl>
                </section>
              </div>
            </article>
          );
        })}
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
        No hay casilleros que coincidan.
      </EmptyList>

      {editing && (
        <ClientEditModal
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
