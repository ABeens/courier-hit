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

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Casillero</th>
              <th>Nombre</th>
              <th>Cédula</th>
              <th>Teléfono</th>
              <th>Correo</th>
              <th>Dirección</th>
              <th>Tarifa</th>
              <th>Límite de crédito</th>
              <th>Trámites</th>
              {canWrite && <th style={{ textAlign: 'right' }}>Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="cell-name mono">{row.code}</div>
                  {row.reviewStatus === ClientReviewStatus.Nuevo && (
                    <span className="spill warn">
                      <span className="dot" />
                      Nuevo
                    </span>
                  )}
                </td>
                <td className="cell-name">{row.name}</td>
                <td className="mono">{row.idNumber}</td>
                <td className="mono">{row.phone ?? '—'}</td>
                <td>{row.email}</td>
                <td>
                  <div>{findProvince(row.provinceCode)?.name ?? '—'}</div>
                  <div className="cell-sub">
                    {findCanton(row.cantonCode)?.name} · {findDistrict(row.districtCode)?.name}
                  </div>
                </td>
                <td>{row.clientRateName ?? <span className="empty-val">Sin tarifa</span>}</td>
                <td>
                  {/* Un monto sin moneda no significa nada (regla M2): si falta, no se inventa. */}
                  {row.creditLimit != null && row.creditLimitCurrency
                    ? formatMoney(row.creditLimit, row.creditLimitCurrency)
                    : <span className="empty-val">Sin límite</span>}
                </td>
                <td>{row.shipmentCount}</td>
                {canWrite && (
                  <td>
                    <div className="actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(row)}>
                        Editar
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
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
