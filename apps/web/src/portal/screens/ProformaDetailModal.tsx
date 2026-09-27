/**
 * Detalle de una proforma (docs/proformas-cambios.html, areas 4, 9 y 10).
 *
 * Lo que se hace aqui depende del estado:
 *   - BORRADOR: se revisa (paquetes, peso total, monto por tarifa), se ajusta
 *     (costos de cada tramite, servicios de la proforma, sacar un paquete a otra
 *     proforma, juntar tramites, reasignar un paquete a otro cliente), se mira la
 *     vista previa y se aprueba.
 *   - APROBADA: se descarga el documento, se anota la factura electronica, se
 *     registra un deposito y, si hace falta y no hay pagos, se corrige (vuelve a
 *     borrador conservando su numero).
 *   - PAGADA: solo consulta.
 *
 * Cada accion la vuelve a validar la API; la pantalla solo evita ofrecer lo que
 * se va a rechazar.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Currency,
  FLOW_LABELS,
  PROFORMA_DELIVERY_STATUS_LABELS,
  PROFORMA_STATUS_LABELS,
  Permission,
  ProformaStatus,
  SHIPMENT_TYPE_LABELS,
  STATE_LABELS,
  can,
  formatMoney,
} from '@courier/shared';
import type {
  DispatchProformasResult,
  ProformaDetailDto,
  ProformaListItem,
  Page,
  Role,
  ShipmentDto,
} from '@courier/shared';
import { IconButton } from '../components/IconButton';
import { ModalOverlay } from '../components/ModalOverlay';
import { API_BASE, ApiError, api } from '../lib/api';
import { formatDate, formatStamp } from '../lib/datetime';
import { AssignOwnerModal } from './AssignOwnerModal';
import { CostsEditorModal } from './CostsEditorModal';
import type { CostsTarget } from './CostsEditorModal';
import { ProformaDepositModal } from './ProformaDepositModal';
import {
  deliveryPill,
  dispatchSummary,
  isDispatchable,
  openProformaDocument,
  proformaStatusPill,
  proformaTotal,
} from './ProformasScreen';

interface Props {
  id: string;
  role: Role;
  onClose: () => void;
  /** Abre otra proforma (la de destino al mover un tramite). */
  onOpen: (id: string) => void;
}

/** Monto en la moneda de la proforma; guion si no hay. */
function money(value: number, currency: Currency): string {
  return formatMoney(value, currency);
}

export function ProformaDetailModal({ id, role, onClose, onOpen }: Props) {
  const canManage = can(role, Permission.ProformasManage);
  const canRecord = can(role, Permission.PaymentsRecord);
  /** Sacar a ruta es el permiso de entregas (Administrador y Mensajeria). */
  const canDispatch = can(role, Permission.DeliveryManage);

  const [data, setData] = useState<ProformaDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fe, setFe] = useState('');

  const [costs, setCosts] = useState<CostsTarget | null>(null);
  const [reassigning, setReassigning] = useState<ShipmentDto | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ProformaListItem[]>([]);
  const [moveTarget, setMoveTarget] = useState<string>('nueva');
  const [depositing, setDepositing] = useState(false);

  const load = useCallback(async () => {
    try {
      const dto = await api.get<ProformaDetailDto>(`/proformas/${id}`);
      setData(dto);
      setFe(dto.electronicInvoiceNumber ?? '');
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar la proforma.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const editable = canManage && (data?.editable ?? false);

  /** El DTO completo del tramite: lo necesitan el editor de costos y la reasignacion. */
  async function loadShipment(shipmentId: string): Promise<ShipmentDto | null> {
    try {
      return await api.get<ShipmentDto>(`/shipments/${shipmentId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar el trámite.');
      return null;
    }
  }

  async function openShipmentCosts(shipmentId: string) {
    const shipment = await loadShipment(shipmentId);
    if (shipment) setCosts({ kind: 'shipment', shipment });
  }

  async function openReassign(shipmentId: string) {
    const shipment = await loadShipment(shipmentId);
    if (shipment) setReassigning(shipment);
  }

  /**
   * Mover un tramite: a una proforma nueva o a otro borrador del mismo cliente,
   * flujo y moneda. Los candidatos se piden al abrir el panel.
   */
  async function openMove(shipmentId: string) {
    if (!data) return;
    setMoving(shipmentId);
    setMoveTarget('nueva');
    try {
      const page = await api.get<Page<ProformaListItem>>(
        `/proformas?clientId=${data.client.id}&status=${ProformaStatus.Borrador}&flow=${data.flow}&pageSize=100`,
      );
      setDrafts(page.items.filter((p) => p.id !== data.id && p.currency === data.currency));
    } catch {
      setDrafts([]);
    }
  }

  async function confirmMove() {
    if (!moving) return;
    setBusy(true);
    setError(null);
    try {
      const target = await api.post<ProformaDetailDto>(`/proformas/${id}/shipments/${moving}/move`, {
        toProformaId: moveTarget === 'nueva' ? null : moveTarget,
      });
      setMoving(null);
      // Si el borrador de origen quedo vacio lo borro la API: se sigue en el destino.
      const stillHere = await api.get<ProformaDetailDto>(`/proformas/${id}`).catch(() => null);
      if (stillHere) {
        setData(stillHere);
        setNotice(`Trámite movido a la proforma ${target.number ?? 'nueva (borrador)'}.`);
      } else {
        onOpen(target.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo mover el trámite.');
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!data) return;
    if (!window.confirm('Al aprobar se asigna el número, se congela el monto y los trámites pasan a cobro. ¿Continuar?')) return;
    setBusy(true);
    setError(null);
    try {
      const dto = await api.post<ProformaDetailDto>(`/proformas/${id}/approve`);
      setData(dto);
      setNotice(`Proforma ${dto.number} aprobada.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo aprobar la proforma.');
    } finally {
      setBusy(false);
    }
  }

  /** Pasa a "En ruta de entrega" los paquetes de esta proforma que siguen en bodega. */
  async function dispatch() {
    if (!data) return;
    const n = data.readyForRouteCount;
    if (!window.confirm(`Se enviarán a ruta de entrega ${n} ${n === 1 ? 'paquete' : 'paquetes'} de esta proforma. ¿Continuar?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const summary = dispatchSummary(await api.post<DispatchProformasResult>('/proformas/dispatch', { ids: [id] }));
      setData(await api.get<ProformaDetailDto>(`/proformas/${id}`));
      if (summary.ok) setNotice(summary.ok);
      if (summary.failed) setError(`No salieron: ${summary.failed}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo enviar a ruta.');
    } finally {
      setBusy(false);
    }
  }

  async function correct() {
    const note = window.prompt('¿Por qué se corrige la proforma? Vuelve a borrador y conserva su número.');
    if (note === null) return;
    setBusy(true);
    setError(null);
    try {
      const dto = await api.post<ProformaDetailDto>(`/proformas/${id}/correct`, { note });
      setData(dto);
      setNotice('La proforma volvió a borrador. Conserva su número para cuando se apruebe de nuevo.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo corregir la proforma.');
    } finally {
      setBusy(false);
    }
  }

  async function saveFe() {
    setBusy(true);
    setError(null);
    try {
      const dto = await api.patch<ProformaDetailDto>(`/proformas/${id}`, {
        electronicInvoiceNumber: fe.trim() ? fe.trim() : null,
      });
      setData(dto);
      setNotice('Factura electrónica guardada.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar la factura electrónica.');
    } finally {
      setBusy(false);
    }
  }

  const other = data?.currency === Currency.USD ? Currency.CRC : Currency.USD;

  return (
    <ModalOverlay onClose={onClose}>
      <div className="modal modal-wide fadeUp" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{data ? (data.number ? `Proforma ${data.number}` : 'Proforma en borrador') : 'Proforma'}</h3>
          {data && (
            <p>
              {data.client.name} · {data.client.code} · {FLOW_LABELS[data.flow]}
            </p>
          )}
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}
          {notice && <div className="banner ok">{notice}</div>}

          {data && (
            <>
              <div className="pay-sec is-money">
                <div className="card-sec-title">Resumen</div>
                <dl className="pay-fields">
                  <div className="card-item-field">
                    <dt>Estado</dt>
                    <dd>
                      <span className={proformaStatusPill(data.status)}>
                        <span className="dot" />
                        {PROFORMA_STATUS_LABELS[data.status]}
                      </span>
                    </dd>
                  </div>
                  <div className="card-item-field">
                    <dt>Entrega</dt>
                    <dd>
                      <span className={deliveryPill(data.deliveryStatus)}>
                        <span className="dot" />
                        {PROFORMA_DELIVERY_STATUS_LABELS[data.deliveryStatus]}
                      </span>
                    </dd>
                  </div>
                  <div className="card-item-field">
                    <dt>Total</dt>
                    <dd className="pay-due">
                      {proformaTotal(data)}
                      {data.exchangeRate !== null && (
                        <div className="cell-sub">
                          {money(other === Currency.USD ? data.totals.usd : data.totals.crc, other)} · TC {data.exchangeRate}
                        </div>
                      )}
                    </dd>
                  </div>
                  <div className="card-item-field">
                    <dt>Peso total</dt>
                    <dd>{data.totalWeightKg !== null ? `${data.totalWeightKg} kg` : '—'}</dd>
                  </div>
                  {data.approvedAt && (
                    <div className="card-item-field">
                      <dt>Aprobada</dt>
                      <dd>
                        {formatStamp(data.approvedAt)}
                        {data.approvedByName ? ` · ${data.approvedByName}` : ''}
                      </dd>
                    </div>
                  )}
                  {data.paidAt && (
                    <div className="card-item-field">
                      <dt>Pagada</dt>
                      <dd>{formatDate(data.paidAt)}</dd>
                    </div>
                  )}
                </dl>
                {data.status === ProformaStatus.Borrador && data.accumulates && (
                  <div className="field-hint">
                    Es el borrador abierto del cliente: los paquetes que se reciban entran aquí hasta que se apruebe.
                  </div>
                )}
              </div>

              <div className="pay-sec">
                <div className="card-sec-title">Trámites ({data.shipments.length})</div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Trámite</th>
                        <th>Guía</th>
                        <th>Descripción</th>
                        <th>Peso</th>
                        <th>Estado</th>
                        <th>Total</th>
                        {editable && <th style={{ textAlign: 'right' }}>Acciones</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {data.shipments.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <span className="mono">{s.code}</span>
                            <div className="cell-sub">{SHIPMENT_TYPE_LABELS[s.shipmentType]}</div>
                          </td>
                          <td className="mono">{s.hawb ?? s.tracking}</td>
                          <td>{s.description}</td>
                          <td>{s.weightKg !== null ? `${s.weightKg} kg` : '—'}</td>
                          <td>{STATE_LABELS[s.state]}</td>
                          <td>
                            {money(s.total, data.currency)}
                            {s.lines.length === 0 && <div className="cell-sub">Sin costos</div>}
                          </td>
                          {editable && (
                            <td>
                              <div className="actions">
                                <IconButton label="Costos del trámite" icon="dollar" onClick={() => void openShipmentCosts(s.id)} />
                                <IconButton label="Mover a otra proforma" icon="arrowR" onClick={() => void openMove(s.id)} />
                                <IconButton label="Reasignar a otro cliente" icon="userSwap" onClick={() => void openReassign(s.id)} />
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {moving && (
                  <div className="banner" style={{ marginTop: 10 }}>
                    <label className="field-label" htmlFor="pd-move">Mover el trámite a</label>
                    <div className="field-pair">
                      <select id="pd-move" className="input" value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)}>
                        <option value="nueva">Una proforma nueva</option>
                        {drafts.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.number ? `Proforma ${d.number}` : 'Borrador'} · {d.shipmentCount} trámites · {proformaTotal(d)}
                          </option>
                        ))}
                      </select>
                      <div className="actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMoving(null)} disabled={busy}>
                          Cancelar
                        </button>
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => void confirmMove()} disabled={busy}>
                          Mover
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="pay-sec">
                <div className="card-sec-title">Servicios de la proforma</div>
                {data.costs.length === 0 ? (
                  <div className="cell-sub">Sin servicios adicionales.</div>
                ) : (
                  <dl className="pay-fields">
                    {data.costs.map((c) => (
                      <div className="card-item-field" key={c.id}>
                        <dt>{c.label}</dt>
                        <dd>{formatMoney(c.amount, c.currency)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {editable && (
                  <div className="pay-sec-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        setCosts({
                          kind: 'proforma',
                          id: data.id,
                          title: 'Servicios de la proforma',
                          subtitle: `${data.client.name} · se cobran por la proforma entera, no por un paquete`,
                        })
                      }
                    >
                      Editar servicios
                    </button>
                  </div>
                )}
              </div>

              {data.status !== ProformaStatus.Borrador && (
                <div className="pay-sec">
                  <div className="card-sec-title">Factura electrónica</div>
                  <div className="field-pair">
                    <input
                      className="input mono"
                      value={fe}
                      disabled={!canManage || busy}
                      placeholder="Consecutivo de la factura electrónica"
                      aria-label="Consecutivo de la factura electrónica"
                      onChange={(e) => setFe(e.target.value)}
                    />
                    {canManage && (
                      <div className="actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void saveFe()} disabled={busy}>
                          Guardar
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cerrar
          </button>
          {data && (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => openProformaDocument(data.id)}>
                {data.status === ProformaStatus.Borrador ? 'Vista previa' : 'Documento (PDF)'}
              </button>
              <a className="btn btn-ghost" href={`${API_BASE}/api/proformas/${data.id}/export.csv`} target="_blank" rel="noreferrer">
                Exportar CSV
              </a>
              {canManage && data.status === ProformaStatus.Aprobada && (
                <button type="button" className="btn btn-ghost" onClick={() => void correct()} disabled={busy}>
                  Corregir
                </button>
              )}
              {canRecord && data.status === ProformaStatus.Aprobada && (
                <button type="button" className="btn btn-ghost" onClick={() => setDepositing(true)} disabled={busy}>
                  Registrar depósito
                </button>
              )}
              {canDispatch && isDispatchable(data) && (
                <button type="button" className="btn btn-primary" onClick={() => void dispatch()} disabled={busy}>
                  {busy ? 'Procesando…' : `Enviar a ruta (${data.readyForRouteCount})`}
                </button>
              )}
              {editable && (
                <button type="button" className="btn btn-primary" onClick={() => void approve()} disabled={busy}>
                  {busy ? 'Procesando…' : 'Aprobar'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {costs && (
        <CostsEditorModal
          target={costs}
          role={role}
          onClose={() => {
            setCosts(null);
            void load();
          }}
        />
      )}

      {reassigning && data && (
        <AssignOwnerModal
          row={reassigning}
          endpoint={`/proformas/${data.id}/shipments/${reassigning.id}/reassign`}
          onClose={() => setReassigning(null)}
          onSaved={(message) => {
            setReassigning(null);
            setNotice(message);
            // Si era el ultimo tramite, la API borro el borrador: no queda que mostrar.
            void api
              .get<ProformaDetailDto>(`/proformas/${data.id}`)
              .then((dto) => setData(dto))
              .catch(() => onClose());
          }}
        />
      )}

      {depositing && data && (
        <ProformaDepositModal
          proforma={data}
          role={role}
          onClose={() => setDepositing(false)}
          onSaved={(message) => {
            setDepositing(false);
            setNotice(message);
            void load();
          }}
        />
      )}
    </ModalOverlay>
  );
}
