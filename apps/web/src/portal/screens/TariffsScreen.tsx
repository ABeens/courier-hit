/**
 * Pantalla "Tarifas" (permiso tariffs.manage, solo admin). CRUD de las tarifas
 * preferenciales de cliente por kg: crear, editar, marcar la por defecto y
 * eliminar (reasignando sus casilleros a la por defecto). La tarifa por defecto
 * no se puede eliminar. La API revalida cada accion.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { ClientRateFormModal } from './ClientRateFormModal';

export interface ClientRateRow {
  id: string;
  name: string;
  pricePerKg: number;
  isDefault: boolean;
  allowsCard: boolean;
  allowsBankDeposit: boolean;
  clientCount: number;
}
interface ListResponse {
  items: ClientRateRow[];
}

type ModalState = { mode: 'create' } | { mode: 'edit'; row: ClientRateRow } | null;

export function TariffsScreen() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [toDelete, setToDelete] = useState<ClientRateRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<ListResponse>('/tariffs/client-rates'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar el listado.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function makeDefault(row: ClientRateRow) {
    setError(null);
    setNotice(null);
    try {
      await api.patch(`/tariffs/client-rates/${row.id}`, { isDefault: true });
      setNotice(`"${row.name}" es ahora la tarifa por defecto.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cambiar la tarifa por defecto.');
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.del<{ reassigned: number }>(`/tariffs/client-rates/${toDelete.id}`);
      setNotice(
        res.reassigned > 0
          ? `Tarifa "${toDelete.name}" eliminada. ${res.reassigned} casillero(s) reasignado(s) a la tarifa por defecto.`
          : `Tarifa "${toDelete.name}" eliminada.`,
      );
      setToDelete(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo eliminar la tarifa.');
      setToDelete(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Tarifas de clientes</div>
          {data && <div className="count">{data.items.length} tarifas · precio por kg</div>}
        </div>
        <button className="btn btn-primary" onClick={() => setModal({ mode: 'create' })}>
          + Nueva tarifa
        </button>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Tarifa</th>
              <th>Precio por kg</th>
              <th>Medios de pago</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="cell-name">
                    {row.name}
                    {row.isDefault && <span className="tag-default">Por defecto</span>}
                  </div>
                </td>
                <td>${row.pricePerKg.toFixed(2)}</td>
                <td>
                  <div className="pay-chips">
                    {row.allowsCard && <span className="role-chip">Tarjeta</span>}
                    {row.allowsBankDeposit && <span className="role-chip">Depósito</span>}
                  </div>
                </td>
                <td>
                  <div className="actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setModal({ mode: 'edit', row })}>
                      Editar
                    </button>
                    {!row.isDefault && (
                      <button className="btn btn-ghost btn-sm" onClick={() => makeDefault(row)}>
                        Hacer predeterminada
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={row.isDefault}
                      title={row.isDefault ? 'La tarifa por defecto no se puede eliminar.' : undefined}
                      onClick={() => setToDelete(row)}
                    >
                      Eliminar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.items.length === 0 && <div className="empty">Aún no hay tarifas configuradas.</div>}

      {modal && (
        <ClientRateFormModal
          mode={modal.mode}
          row={modal.mode === 'edit' ? modal.row : undefined}
          onClose={() => setModal(null)}
          onSaved={(message) => {
            setModal(null);
            setNotice(message ?? null);
            setError(null);
            void load();
          }}
        />
      )}

      {toDelete && (
        <div className="overlay" onMouseDown={() => !busy && setToDelete(null)}>
          <div className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Eliminar tarifa</h3>
              <p>Vas a eliminar la tarifa "{toDelete.name}".</p>
            </div>
            <div className="modal-body">
              <div className="banner warn">
                {toDelete.clientCount > 0 ? (
                  <>
                    Hay <strong>{toDelete.clientCount}</strong> casillero(s) con esta tarifa. Si aceptas, todos
                    pasarán a la <strong>tarifa por defecto</strong>. Esta acción no se puede deshacer.
                  </>
                ) : (
                  <>Ningún casillero usa esta tarifa. Esta acción no se puede deshacer.</>
                )}
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setToDelete(null)} disabled={busy}>
                Cancelar
              </button>
              <button type="button" className="btn btn-danger" onClick={confirmDelete} disabled={busy}>
                {busy ? 'Eliminando…' : 'Eliminar tarifa'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
