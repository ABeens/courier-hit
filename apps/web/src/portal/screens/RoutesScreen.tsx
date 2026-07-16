/**
 * Pantalla "Definición de rutas" (permiso routes.manage, solo admin).
 * Lista TODOS los distritos del pais (Provincia > Cantón > Distrito) desde el
 * catalogo territorial de @courier/shared y, junto a cada uno, un campo donde el
 * administrador escribe el número de ruta que le corresponde. Asignar, editar y
 * quitar rutas; filtrar por provincia, cantón, texto y estado de asignación.
 * La API (routes.manage) revalida cada acción.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PROVINCES, getAllDistricts, getCantons } from '@courier/shared';
import type { DistrictListItem, DistrictRouteDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';

interface ListResponse {
  items: DistrictRouteDto[];
  counts: { assigned: number; routes: number };
}

// El catalogo es estatico: se aplana una sola vez al cargar el modulo.
const ALL_DISTRICTS: DistrictListItem[] = getAllDistricts();

export function RoutesScreen() {
  const [routes, setRoutes] = useState<Map<string, number>>(new Map());
  const [counts, setCounts] = useState({ assigned: 0, routes: 0 });
  const [q, setQ] = useState('');
  const [province, setProvince] = useState('');
  const [canton, setCanton] = useState('');
  const [assignment, setAssignment] = useState(''); // '' | 'assigned' | 'unassigned'
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<ListResponse>('/routes');
      setRoutes(new Map(data.items.map((i) => [i.districtCode, i.routeNumber])));
      setCounts(data.counts);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar la definición de rutas.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Al cambiar de provincia, el canton seleccionado deja de ser valido.
  const cantons = useMemo(() => (province ? getCantons(province) : []), [province]);
  function selectProvince(code: string) {
    setProvince(code);
    setCanton('');
  }

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return ALL_DISTRICTS.filter((d) => {
      if (province && d.provinceCode !== province) return false;
      if (canton && d.cantonCode !== canton) return false;
      const isAssigned = routes.has(d.districtCode);
      if (assignment === 'assigned' && !isAssigned) return false;
      if (assignment === 'unassigned' && isAssigned) return false;
      if (term) {
        const hay = `${d.districtName} ${d.cantonName} ${d.provinceName} ${d.districtCode}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [q, province, canton, assignment, routes]);

  async function save(code: string) {
    const raw = (edits[code] ?? '').trim();
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n <= 0) {
      setError('Ingresa un número de ruta válido (entero mayor que cero).');
      return;
    }
    setBusyCode(code);
    setError(null);
    setNotice(null);
    try {
      await api.put(`/routes/${code}`, { routeNumber: n });
      setEdits((prev) => {
        const next = { ...prev };
        delete next[code];
        return next;
      });
      setNotice(`Ruta ${n} asignada al distrito.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar la ruta.');
    } finally {
      setBusyCode(null);
    }
  }

  async function remove(code: string) {
    setBusyCode(code);
    setError(null);
    setNotice(null);
    try {
      await api.del(`/routes/${code}`);
      setEdits((prev) => {
        const next = { ...prev };
        delete next[code];
        return next;
      });
      setNotice('Ruta eliminada del distrito.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo eliminar la ruta.');
    } finally {
      setBusyCode(null);
    }
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Definición de rutas</div>
          <div className="count">
            {counts.assigned} distritos asignados · {counts.routes} rutas · {ALL_DISTRICTS.length} distritos en total
          </div>
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="filters">
        <input
          className="input search"
          placeholder="Buscar distrito, cantón o código…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="input" value={province} onChange={(e) => selectProvince(e.target.value)}>
          <option value="">Todas las provincias</option>
          {PROVINCES.map((p) => (
            <option key={p.code} value={p.code}>{p.name}</option>
          ))}
        </select>
        <select
          className="input"
          value={canton}
          onChange={(e) => setCanton(e.target.value)}
          disabled={!province}
        >
          <option value="">{province ? 'Todos los cantones' : 'Elige una provincia'}</option>
          {cantons.map((c) => (
            <option key={c.code} value={c.code}>{c.name}</option>
          ))}
        </select>
        <select className="input" value={assignment} onChange={(e) => setAssignment(e.target.value)}>
          <option value="">Todos</option>
          <option value="assigned">Con ruta</option>
          <option value="unassigned">Sin ruta</option>
        </select>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Provincia</th>
              <th>Cantón</th>
              <th>Distrito</th>
              <th>Código</th>
              <th style={{ width: 130 }}>Ruta</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const stored = routes.get(d.districtCode);
              const storedStr = stored != null ? String(stored) : '';
              const shown = d.districtCode in edits ? edits[d.districtCode] : storedStr;
              const dirty = shown.trim() !== storedStr;
              const busy = busyCode === d.districtCode;
              return (
                <tr key={d.districtCode}>
                  <td>{d.provinceName}</td>
                  <td>{d.cantonName}</td>
                  <td><div className="cell-name">{d.districtName}</div></td>
                  <td>{d.districtCode}</td>
                  <td>
                    <input
                      className="input"
                      style={{ width: 90 }}
                      inputMode="numeric"
                      placeholder="—"
                      value={shown}
                      disabled={busy}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [d.districtCode]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && dirty) void save(d.districtCode);
                      }}
                    />
                  </td>
                  <td>
                    <div className="actions">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!dirty || busy}
                        onClick={() => save(d.districtCode)}
                      >
                        Guardar
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={stored == null || busy}
                        onClick={() => remove(d.districtCode)}
                      >
                        Quitar
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && <div className="empty">No hay distritos que coincidan.</div>}
    </div>
  );
}
