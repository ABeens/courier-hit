/**
 * Pantalla "Definición de rutas" (permiso routes.manage, solo admin).
 * Lista TODOS los distritos del pais (Provincia > Cantón > Distrito) desde el
 * catalogo territorial de @courier/shared, agrupados por cantón.
 *
 * DOS NIVELES. La cabecera de cada grupo asigna la ruta del CANTÓN entero: sus
 * distritos la heredan. La fila de cada distrito asigna una ruta PROPIA, que es
 * una excepción y manda sobre la del cantón; quitarla devuelve el distrito a la
 * ruta heredada. Por eso el campo del distrito se deja vacio cuando hereda (el
 * numero heredado va de marcador de posicion): escribir en el crea la excepción.
 *
 * La API (routes.manage) revalida cada acción y resuelve la misma precedencia.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PROVINCES, getAllDistricts, getCantons, resolveDistrictRoute } from '@courier/shared';
import type { CantonRouteDto, DistrictListItem, DistrictRouteDto } from '@courier/shared';
import { FilterBar } from '../components/FilterBar';
import type { FilterChip } from '../components/FilterBar';
import { ApiError, api } from '../lib/api';

interface ListResponse {
  items: DistrictRouteDto[];
  cantons: CantonRouteDto[];
  counts: { assigned: number; routes: number };
}

/** Un cantón con los distritos suyos que pasaron los filtros. */
interface CantonGroup {
  cantonCode: string;
  cantonName: string;
  provinceName: string;
  districts: DistrictListItem[];
}

// El catalogo es estatico: se aplana una sola vez al cargar el modulo.
const ALL_DISTRICTS: DistrictListItem[] = getAllDistricts();

const ASSIGNMENT_LABELS: Record<string, string> = {
  assigned: 'Con ruta',
  unassigned: 'Sin ruta',
  own: 'Solo excepciones',
};

export function RoutesScreen() {
  const [routes, setRoutes] = useState<Map<string, number>>(new Map());
  const [cantonRoutes, setCantonRoutes] = useState<Map<string, number>>(new Map());
  const [counts, setCounts] = useState({ assigned: 0, routes: 0 });
  const [q, setQ] = useState('');
  const [province, setProvince] = useState('');
  const [canton, setCanton] = useState('');
  const [assignment, setAssignment] = useState(''); // '' | 'assigned' | 'unassigned' | 'own'
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [cantonEdits, setCantonEdits] = useState<Record<string, string>>({});
  // Clave con prefijo: distrito y cantón comparten este estado y sus codigos son
  // ambos numericos.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<ListResponse>('/routes');
      setRoutes(new Map(data.items.map((i) => [i.districtCode, i.routeNumber])));
      setCantonRoutes(new Map(data.cantons.map((c) => [c.cantonCode, c.routeNumber])));
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

  /**
   * Lo aplicado ademas del buscador: con el panel cerrado, esto es lo unico que
   * dice por que la tabla esta recortada. Quitar la provincia se lleva por
   * delante el canton, igual que al cambiarla: fuera de su provincia no existe.
   */
  const chips: FilterChip[] = [
    ...(province
      ? [{
          label: `Provincia: ${PROVINCES.find((p) => p.code === province)?.name ?? province}`,
          onClear: () => selectProvince(''),
        }]
      : []),
    ...(canton
      ? [{
          label: `Cantón: ${cantons.find((c) => c.code === canton)?.name ?? canton}`,
          onClear: () => setCanton(''),
        }]
      : []),
    ...(assignment
      ? [{
          label: `Asignación: ${ASSIGNMENT_LABELS[assignment] ?? assignment}`,
          onClear: () => setAssignment(''),
        }]
      : []),
  ];

  function clearFilters() {
    selectProvince('');
    setAssignment('');
  }

  /**
   * Los filtros miran la ruta EFECTIVA (propia o heredada del cantón), que es la
   * que va a usar el mensajero; "Solo excepciones" es el unico que mira la ruta
   * propia, porque sirve justo para revisar lo que se salio de su cantón.
   */
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return ALL_DISTRICTS.filter((d) => {
      if (province && d.provinceCode !== province) return false;
      if (canton && d.cantonCode !== canton) return false;
      if (assignment) {
        const effective = resolveDistrictRoute(d, routes, cantonRoutes);
        if (assignment === 'assigned' && !effective) return false;
        if (assignment === 'unassigned' && effective) return false;
        if (assignment === 'own' && !routes.has(d.districtCode)) return false;
      }
      if (term) {
        const hay = `${d.districtName} ${d.cantonName} ${d.provinceName} ${d.districtCode}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [q, province, canton, assignment, routes, cantonRoutes]);

  /**
   * Agrupa por cantón para colgar de cada grupo su asignación. El catalogo ya
   * viene ordenado Provincia > Cantón > Distrito, asi que los distritos de un
   * mismo cantón son contiguos y basta con cortar al cambiar de codigo.
   */
  const groups = useMemo(() => {
    const out: CantonGroup[] = [];
    for (const d of rows) {
      const last = out[out.length - 1];
      if (last && last.cantonCode === d.cantonCode) {
        last.districts.push(d);
        continue;
      }
      out.push({
        cantonCode: d.cantonCode,
        cantonName: d.cantonName,
        provinceName: d.provinceName,
        districts: [d],
      });
    }
    return out;
  }, [rows]);

  /** Numero de ruta escrito por el usuario, o null si no es valido. */
  function parseRoute(raw: string): number | null {
    const trimmed = raw.trim();
    const n = Number(trimmed);
    if (!trimmed || !Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  /**
   * Envoltura comun de las cuatro acciones: deja la fila ocupada, limpia los
   * mensajes y recarga. La recarga es del listado completo a proposito: cambiar
   * un cantón mueve la ruta efectiva de todos sus distritos, no solo de la fila
   * tocada.
   */
  async function run(key: string, action: () => Promise<void>, ok: string, fail: string) {
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(ok);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fail);
    } finally {
      setBusyKey(null);
    }
  }

  function forgetEdit(code: string) {
    setEdits((prev) => {
      const next = { ...prev };
      delete next[code];
      return next;
    });
  }

  async function save(code: string) {
    const n = parseRoute(edits[code] ?? '');
    if (n === null) {
      setError('Ingresa un número de ruta válido (entero mayor que cero).');
      return;
    }
    await run(
      `d:${code}`,
      async () => {
        await api.put(`/routes/districts/${code}`, { routeNumber: n });
        forgetEdit(code);
      },
      `Ruta ${n} asignada al distrito.`,
      'No se pudo guardar la ruta.',
    );
  }

  async function remove(code: string, cantonCode: string) {
    const inherited = cantonRoutes.get(cantonCode);
    await run(
      `d:${code}`,
      async () => {
        await api.del(`/routes/districts/${code}`);
        forgetEdit(code);
      },
      inherited != null
        ? `Se quitó la ruta propia: el distrito vuelve a la ruta ${inherited} de su cantón.`
        : 'Se quitó la ruta propia del distrito.',
      'No se pudo eliminar la ruta.',
    );
  }

  /** Cuantos distritos del cantón tienen ruta propia: no los toca asignar el cantón. */
  function ownRoutesIn(cantonCode: string): number {
    let n = 0;
    for (const d of ALL_DISTRICTS) {
      if (d.cantonCode === cantonCode && routes.has(d.districtCode)) n += 1;
    }
    return n;
  }

  async function saveCanton(code: string, name: string) {
    const n = parseRoute(cantonEdits[code] ?? '');
    if (n === null) {
      setError('Ingresa un número de ruta válido (entero mayor que cero).');
      return;
    }
    const kept = ownRoutesIn(code);
    await run(
      `c:${code}`,
      async () => {
        await api.put(`/routes/cantons/${code}`, { routeNumber: n });
        setCantonEdits((prev) => {
          const next = { ...prev };
          delete next[code];
          return next;
        });
      },
      kept > 0
        ? `Ruta ${n} asignada a ${name}. ${kept} ${kept === 1 ? 'distrito conserva su ruta propia' : 'distritos conservan su ruta propia'}.`
        : `Ruta ${n} asignada a todos los distritos de ${name}.`,
      'No se pudo guardar la ruta del cantón.',
    );
  }

  async function removeCanton(code: string, name: string) {
    await run(
      `c:${code}`,
      async () => {
        await api.del(`/routes/cantons/${code}`);
        setCantonEdits((prev) => {
          const next = { ...prev };
          delete next[code];
          return next;
        });
      },
      `${name} deja de tener ruta: sus distritos sin ruta propia quedan sin asignar.`,
      'No se pudo eliminar la ruta del cantón.',
    );
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Definición de rutas</div>
          <div className="count">
            {counts.assigned} distritos con ruta · {counts.routes} rutas ·{' '}
            {cantonRoutes.size} cantones asignados · {ALL_DISTRICTS.length} distritos en total
          </div>
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="banner info" style={{ marginBottom: 14 }}>
        La ruta del cantón la heredan todos sus distritos. Si un distrito necesita
        otra, escríbela en su fila: esa ruta propia manda sobre la del cantón y no
        se pierde al reasignar el cantón.
      </div>

      <FilterBar
        search={{ value: q, onChange: setQ, placeholder: 'Buscar distrito, cantón o código…' }}
        chips={chips}
        onClearAll={clearFilters}
      >
        {/* Provincia y canton son un embudo: el canton solo existe dentro de una
            provincia, asi que van juntos en la misma fila. */}
        <div className="field-pair">
          <div>
            <label className="field-label" htmlFor="f-province">Provincia</label>
            <select
              id="f-province" className="input" value={province}
              onChange={(e) => selectProvince(e.target.value)}
            >
              <option value="">Todas</option>
              {PROVINCES.map((p) => (
                <option key={p.code} value={p.code}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="f-canton">Cantón</label>
            <select
              id="f-canton"
              className="input"
              value={canton}
              onChange={(e) => setCanton(e.target.value)}
              disabled={!province}
            >
              <option value="">{province ? 'Todos' : 'Elige provincia'}</option>
              {cantons.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="field-label" htmlFor="f-assignment">Asignación</label>
          <select
            id="f-assignment" className="input" value={assignment}
            onChange={(e) => setAssignment(e.target.value)}
          >
            <option value="">Todos</option>
            <option value="assigned">Con ruta</option>
            <option value="unassigned">Sin ruta</option>
            <option value="own">Solo excepciones</option>
          </select>
        </div>
      </FilterBar>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Distrito</th>
              <th>Código</th>
              <th style={{ width: 130 }}>Ruta propia</th>
              <th>Ruta efectiva</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const cantonStored = cantonRoutes.get(g.cantonCode);
              const cantonStoredStr = cantonStored != null ? String(cantonStored) : '';
              const cantonShown =
                g.cantonCode in cantonEdits ? cantonEdits[g.cantonCode] : cantonStoredStr;
              const cantonDirty = cantonShown.trim() !== cantonStoredStr;
              const cantonBusy = busyKey === `c:${g.cantonCode}`;
              return [
                <tr key={`c:${g.cantonCode}`} className="canton-row">
                  <td colSpan={5}>
                    <div className="canton-head">
                      <div>
                        <span className="canton-title">{g.cantonName}</span>{' '}
                        <span className="cell-sub">{g.provinceName} · {g.cantonCode}</span>
                      </div>
                      <div className="canton-assign">
                        <label className="field-label" htmlFor={`canton-${g.cantonCode}`}>
                          Ruta del cantón
                        </label>
                        <input
                          id={`canton-${g.cantonCode}`}
                          className="input"
                          style={{ width: 90 }}
                          inputMode="numeric"
                          placeholder="—"
                          value={cantonShown}
                          disabled={cantonBusy}
                          onChange={(e) =>
                            setCantonEdits((prev) => ({ ...prev, [g.cantonCode]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && cantonDirty) {
                              void saveCanton(g.cantonCode, g.cantonName);
                            }
                          }}
                        />
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={!cantonDirty || cantonBusy}
                          onClick={() => saveCanton(g.cantonCode, g.cantonName)}
                        >
                          Guardar
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={cantonStored == null || cantonBusy}
                          onClick={() => removeCanton(g.cantonCode, g.cantonName)}
                        >
                          Quitar
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>,
                ...g.districts.map((d) => {
                  const stored = routes.get(d.districtCode);
                  const storedStr = stored != null ? String(stored) : '';
                  const shown = d.districtCode in edits ? edits[d.districtCode] : storedStr;
                  const dirty = shown.trim() !== storedStr;
                  const busy = busyKey === `d:${d.districtCode}`;
                  const effective = resolveDistrictRoute(d, routes, cantonRoutes);
                  return (
                    <tr key={d.districtCode}>
                      <td><div className="cell-name">{d.districtName}</div></td>
                      <td>{d.districtCode}</td>
                      <td>
                        <input
                          className="input"
                          style={{ width: 90 }}
                          inputMode="numeric"
                          aria-label={`Ruta propia de ${d.districtName}`}
                          // Vacio con el numero del cantón de marcador: deja ver
                          // que hereda sin hacer pasar lo heredado por guardado.
                          placeholder={cantonStored != null ? String(cantonStored) : '—'}
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
                        {effective ? (
                          <>
                            <div className="cell-name">Ruta {effective.routeNumber}</div>
                            <div className="cell-sub">
                              {effective.source === 'canton'
                                ? 'Heredada del cantón'
                                : cantonStored != null
                                  ? `Propia (cantón: ${cantonStored})`
                                  : 'Propia'}
                            </div>
                          </>
                        ) : (
                          <span className="muted">Sin ruta</span>
                        )}
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
                            onClick={() => remove(d.districtCode, d.cantonCode)}
                          >
                            Quitar
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && <div className="empty">No hay distritos que coincidan.</div>}
    </div>
  );
}
