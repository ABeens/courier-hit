/**
 * Pantalla "Resumen" (permiso dashboard.read).
 *
 * No es un tablero de metricas: son las COLAS DE TRABAJO del dia. Cada cifra
 * responde a "¿que tengo pendiente?" y lleva directo a la pantalla donde se
 * resuelve, porque un numero que no se puede accionar solo ocupa espacio.
 */
import { useEffect, useState } from 'react';
import { SHIPMENT_TYPE_LABELS, STATE_LABELS } from '@courier/shared';
import type { ShipmentType, State } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/datetime';

interface Queue {
  state: State;
  label: string;
  total: number;
}

interface Summary {
  queues: Queue[];
  pendingPayments: number;
  byType: { shipmentType: ShipmentType; total: number }[];
  recent: {
    id: string;
    code: string;
    shipmentType: ShipmentType;
    state: State;
    tracking: string;
    clientName: string;
    createdAt: string;
  }[];
}

export function DashboardScreen() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Summary>('/dashboard')
      .then(setData)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'No se pudo cargar el resumen.'),
      );
  }, []);

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Resumen</div>
          <div className="count">Colas de trabajo del día</div>
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="filters" style={{ gap: 12 }}>
        {data?.queues.map((queue) => (
          <div className="card-item" key={queue.state} style={{ flex: '1 1 180px', padding: 16 }}>
            <div className="card-item-ident">
              <div className="card-item-code" style={{ fontSize: 28 }}>{queue.total}</div>
              <div className="card-item-sub">{queue.label}</div>
            </div>
          </div>
        ))}
        {data && (
          <div className="card-item" style={{ flex: '1 1 180px', padding: 16 }}>
            <div className="card-item-ident">
              <div className="card-item-code" style={{ fontSize: 28 }}>{data.pendingPayments}</div>
              <div className="card-item-sub">Depósitos por validar</div>
            </div>
          </div>
        )}
      </div>

      {data && data.byType.length > 0 && (
        <>
          <div className="card-sec-title" style={{ marginTop: 24 }}>Trámites por tipo</div>
          <div className="filters" style={{ gap: 12 }}>
            {data.byType.map((row) => (
              <div className="card-item" key={row.shipmentType} style={{ flex: '1 1 160px', padding: 14 }}>
                <div className="card-item-ident">
                  <div className="card-item-code" style={{ fontSize: 22 }}>{row.total}</div>
                  <div className="card-item-sub">{SHIPMENT_TYPE_LABELS[row.shipmentType]}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="card-sec-title" style={{ marginTop: 24 }}>Últimos ingresos</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Consecutivo</th>
              <th>Trámite</th>
              <th>Cliente</th>
              <th>Tracking</th>
              <th>Estatus</th>
              <th>Fecha ingreso</th>
            </tr>
          </thead>
          <tbody>
            {data?.recent.map((row) => (
              <tr key={row.id}>
                <td className="mono">{row.code}</td>
                <td>{SHIPMENT_TYPE_LABELS[row.shipmentType]}</td>
                <td>{row.clientName}</td>
                <td className="mono">{row.tracking}</td>
                <td>{STATE_LABELS[row.state]}</td>
                <td>{formatDate(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.recent.length === 0 && <div className="empty">Todavía no hay trámites.</div>}
    </div>
  );
}
