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
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClientReviewStatus,
  Currency,
  findCanton,
  findDistrict,
  findProvince,
  formatMoney,
} from '@courier/shared';
import { ApiError, api } from '../lib/api';
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

export function ClientsScreen({ canWrite }: { canWrite: boolean }) {
  const [items, setItems] = useState<ClientRow[] | null>(null);
  const [q, setQ] = useState('');
  const [onlyNew, setOnlyNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ClientRow | null>(null);

  const load = useCallback(async () => {
    const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    try {
      const data = await api.get<{ items: ClientRow[] }>(`/clients${qs}`);
      setItems(data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar el listado.');
    }
  }, [q]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce de la busqueda
    return () => clearTimeout(t);
  }, [load]);

  /**
   * El filtro de "nuevos" se aplica en el cliente y no en la API a proposito: es
   * un subconjunto de lo ya cargado, asi que alternarlo no debe costar un viaje
   * al servidor. La busqueda si va al servidor porque ahi si puede haber filas
   * que no estan en memoria.
   */
  const visible = useMemo(
    () =>
      onlyNew
        ? (items ?? []).filter((c) => c.reviewStatus === ClientReviewStatus.Nuevo)
        : (items ?? []),
    [items, onlyNew],
  );

  const newCount = useMemo(
    () => (items ?? []).filter((c) => c.reviewStatus === ClientReviewStatus.Nuevo).length,
    [items],
  );

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Clientes</div>
          {items && (
            <div className="count">
              {items.length} casilleros · {newCount} por revisar
            </div>
          )}
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="filters">
        <input
          className="input search"
          placeholder="Buscar por nombre, casillero, cédula o correo…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="input"
          value={onlyNew ? 'nuevos' : ''}
          onChange={(e) => setOnlyNew(e.target.value === 'nuevos')}
        >
          <option value="">Todos los casilleros</option>
          <option value="nuevos">Solo nuevos (por revisar)</option>
        </select>
      </div>

      <div className="cards">
        {visible.map((row) => {
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
          return (
            <article className={`card-item tone-${CLIENT_TONE[row.reviewStatus]}`} key={row.id}>
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
                    {CLIENT_STATUS_LABEL[row.reviewStatus]}
                  </span>
                  {canWrite && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(row)}>
                      Editar
                    </button>
                  )}
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

      {items && visible.length === 0 && (
        <div className="empty">No hay casilleros que coincidan.</div>
      )}

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
