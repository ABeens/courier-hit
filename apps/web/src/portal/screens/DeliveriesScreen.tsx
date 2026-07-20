/**
 * Pantalla "Entregas" (permiso delivery.manage) — Requerimientos Parte 5.
 *
 * Es la pantalla del mensajero y se diseña para eso: se usa de pie, con una mano
 * y en la calle. Por eso lista TARJETAS y no una tabla (una tabla de 10 columnas
 * es inservible en un telefono), muestra la direccion y el telefono del cliente
 * completos, y las dos unicas acciones posibles —confirmar o devolver— son
 * botones grandes.
 *
 * La foto se toma con la camara del propio telefono: `capture="environment"`
 * abre la camara trasera directamente en vez del explorador de archivos.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  DELIVERY_OUTCOME_LABELS,
  DeliveryOutcome,
  SHIPMENT_TYPE_LABELS,
  findCanton,
  findDistrict,
  findProvince,
} from '@courier/shared';
import type { ShipmentType } from '@courier/shared';
import { API_BASE, ApiError, api } from '../lib/api';
import { DeliveryConfirmModal } from './DeliveryConfirmModal';

export interface DeliveryQueueRow {
  id: string;
  code: string;
  tracking: string;
  description: string;
  shipmentType: ShipmentType;
  clientName: string;
  clientPhone: string | null;
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
  routeNumber: number | null;
  invoiceTotalCrc: number | null;
  updatedAt: string;
}

type ModalState = { row: DeliveryQueueRow; outcome: DeliveryOutcome } | null;

export function DeliveriesScreen() {
  const [items, setItems] = useState<DeliveryQueueRow[] | null>(null);
  const [q, setQ] = useState('');
  const [route, setRoute] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (route.trim()) params.set('routeNumber', route.trim());
    const qs = params.toString();
    try {
      const data = await api.get<{ items: DeliveryQueueRow[] }>(
        `/deliveries/queue${qs ? `?${qs}` : ''}`,
      );
      setItems(data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar la ruta.');
    }
  }, [q, route]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce de la busqueda
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Entregas</div>
          {items && <div className="count">{items.length} paquetes en ruta</div>}
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="filters">
        <input
          className="input search"
          placeholder="Buscar por nombre o tracking…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          className="input"
          type="number"
          min={1}
          placeholder="Ruta"
          style={{ maxWidth: 120 }}
          value={route}
          onChange={(e) => setRoute(e.target.value)}
        />
      </div>

      <div className="cards">
        {items?.map((row) => (
          <article className="card-item tone-info" key={row.id}>
            <div className="card-item-head">
              <div className="card-item-ident">
                <div className="card-item-code">{row.code}</div>
                <div className="card-item-title">{row.clientName}</div>
                <div className="card-item-sub">
                  {SHIPMENT_TYPE_LABELS[row.shipmentType]} · {row.tracking}
                </div>
              </div>
              <div className="card-item-aside">
                <span className="spill">
                  <span className="dot" />
                  {row.routeNumber != null ? `Ruta ${row.routeNumber}` : 'Sin ruta'}
                </span>
              </div>
            </div>

            <div className="card-item-body">
              <div className="card-item-field">
                <span className="field-label">Dirección</span>
                <span>
                  {findProvince(row.provinceCode)?.name}, {findCanton(row.cantonCode)?.name},{' '}
                  {findDistrict(row.districtCode)?.name}
                </span>
              </div>
              <div className="card-item-field">
                <span className="field-label">Otras señas</span>
                <span>{row.addressLine}</span>
              </div>
              <div className="card-item-field">
                <span className="field-label">Teléfono</span>
                {/* Enlace `tel:` a proposito: el mensajero llama desde la propia tarjeta. */}
                <span>{row.clientPhone ? <a href={`tel:${row.clientPhone}`}>{row.clientPhone}</a> : '—'}</span>
              </div>
              <div className="card-item-field">
                <span className="field-label">Descripción</span>
                <span>{row.description}</span>
              </div>
            </div>

            <div className="actions">
              <button
                className="btn btn-primary"
                onClick={() => setModal({ row, outcome: DeliveryOutcome.Entregado })}
              >
                Confirmar entrega
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setModal({ row, outcome: DeliveryOutcome.DevueltoBodega })}
              >
                Devolver a bodega
              </button>
            </div>
          </article>
        ))}
      </div>

      {items && items.length === 0 && (
        <div className="empty">No hay paquetes en ruta que coincidan.</div>
      )}

      {modal && (
        <DeliveryConfirmModal
          row={modal.row}
          outcome={modal.outcome}
          onClose={() => setModal(null)}
          onSaved={() => {
            setNotice(
              `${modal.row.code}: ${DELIVERY_OUTCOME_LABELS[modal.outcome].toLowerCase()}.`,
            );
            setError(null);
            setModal(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Ruta de descarga de la foto de un intento; la usa el historial del trámite. */
export function attemptPhotoUrl(attemptId: string): string {
  return `${API_BASE}/api/deliveries/attempts/${attemptId}/photo`;
}
