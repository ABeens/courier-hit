/**
 * Pantalla "Reportes" — Requerimientos Parte 6 (matriz de roles).
 *
 * El catálogo de reportes disponibles lo decide la API a partir del rol
 * (`/reports/catalog`), no esta pantalla: así un Financiero ve solo el reporte
 * financiero sin que el portal tenga que replicar la matriz de permisos.
 *
 * Las columnas también vienen del servidor con los datos. La tabla se dibuja a
 * partir de ellas, sin conocer de antemano ningún reporte: agregar uno nuevo en
 * `@courier/shared` lo hace aparecer aquí sin tocar este archivo.
 */
import { useCallback, useEffect, useState } from 'react';
import { ReportKind, SHIPMENT_TYPE_LABELS, ShipmentType } from '@courier/shared';
import type { ReportColumn, ReportRow } from '@courier/shared';
import { API_BASE, ApiError, api } from '../lib/api';
import { startOfLocalDayUtc, startOfNextLocalDayUtc } from '../lib/datetime';

interface CatalogItem {
  kind: ReportKind;
  label: string;
  description: string;
}

interface ReportResponse {
  kind: ReportKind;
  columns: ReportColumn[];
  rows: ReportRow[];
}

export function ReportsScreen() {
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [kind, setKind] = useState<ReportKind | ''>('');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .get<{ items: CatalogItem[] }>('/reports/catalog')
      .then((data) => {
        setCatalog(data.items);
        // Se preselecciona el primero al que el rol tiene acceso: la pantalla
        // abre con algo utilizable en vez de un selector vacío.
        setKind(data.items[0]?.kind ?? '');
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'No se pudo cargar el catálogo.'),
      );
  }, []);

  /** Parámetros comunes a la consulta y a la descarga: una sola construcción. */
  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (type) params.set('shipmentType', type);
    if (from) params.set('from', startOfLocalDayUtc(from));
    if (to) params.set('to', startOfNextLocalDayUtc(to));
    return params;
  }, [kind, type, from, to]);

  const load = useCallback(async () => {
    if (!kind) return;
    setLoading(true);
    try {
      setReport(await api.get<ReportResponse>(`/reports?${buildParams().toString()}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo generar el reporte.');
    } finally {
      setLoading(false);
    }
  }, [buildParams, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * La descarga es una navegación normal y no un `fetch`: el navegador tiene que
   * recibir el `content-disposition` para guardar el archivo, y la cookie de
   * sesión viaja igual por ser el mismo origen de la API.
   */
  function downloadCsv() {
    const params = buildParams();
    params.set('format', 'csv');
    window.open(`${API_BASE}/api/reports?${params.toString()}`, '_blank');
  }

  const selected = catalog?.find((item) => item.kind === kind);

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Reportes</div>
          {selected && <div className="count">{selected.description}</div>}
        </div>
        <button className="btn btn-primary" onClick={downloadCsv} disabled={!report || !kind}>
          Descargar CSV
        </button>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="filters">
        <select
          className="input search"
          value={kind}
          onChange={(e) => setKind(e.target.value as ReportKind)}
        >
          {catalog?.map((item) => (
            <option key={item.kind} value={item.kind}>
              {item.label}
            </option>
          ))}
        </select>
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Todos los trámites</option>
          {Object.values(ShipmentType).map((t) => (
            <option key={t} value={t}>
              {SHIPMENT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="Desde"
        />
        <input
          className="input"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="Hasta"
        />
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {report?.columns.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report?.rows.map((row, index) => (
              <tr key={index}>
                {report.columns.map((column) => (
                  <td key={column.key}>
                    {row[column.key] ?? <span className="empty-val">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {loading && <div className="empty">Generando…</div>}
      {!loading && report && report.rows.length === 0 && (
        <div className="empty">No hay datos para ese filtro.</div>
      )}
    </div>
  );
}
