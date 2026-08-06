/**
 * FilterBar — barra de filtros de un listado del portal.
 *
 * La barra abierta se comía una franja entera de la pantalla —cinco controles
 * en fila, casi siempre vacíos— antes de la primera fila de datos. Aquí solo
 * queda a la vista lo que se usa en cada visita: el buscador y un botón
 * «Filtros» que cuelga un panel con el resto.
 *
 * Dos reglas que el panel NO puede romper:
 *   - Filtra al instante, sin botón de aplicar. Es el mismo estado de siempre;
 *     el panel solo decide dónde se dibujan los controles, no cuándo corren.
 *   - Lo aplicado se ve con el panel CERRADO. Para eso están las fichas: un
 *     filtro escondido que sigue recortando el listado es la forma segura de
 *     que alguien jure que "faltan trámites".
 */
import { useEffect, useRef, useState } from 'react';

/** Un filtro aplicado, tal y como se le enseña al usuario. */
export interface FilterChip {
  /** Ya legible y con su campo delante: "Estado: En bodega". */
  label: string;
  /** Deja SOLO este filtro sin valor. */
  onClear: () => void;
}

interface Props {
  /** Buscador, siempre visible: es el filtro que se usa en cada visita. */
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  /**
   * Control que NO se pliega, en el sitio del buscador. Para lo que manda sobre
   * la pantalla entera y no recorta un listado (el selector de reporte: sin el
   * puesto no hay nada que mirar). Un filtro normal no va aquí, va al panel.
   */
  lead?: React.ReactNode;
  /** Filtros aplicados: pintan las fichas y son los que cuenta el botón. */
  chips: FilterChip[];
  /** Vacía de golpe los filtros que pintan ficha. El buscador NO: está a la
   *  vista y se limpia solo, y borrarlo desde aquí es lo que nadie espera. */
  onClearAll: () => void;
  /** Controles del panel. Cada uno con su `.field-label`, como en un formulario. */
  children: React.ReactNode;
}

export function FilterBar({ search, lead, chips, onClearAll, children }: Props) {
  const [open, setOpen] = useState(false);
  /** El panel y su botón: un clic aquí dentro NO lo cierra. */
  const root = useRef<HTMLDivElement>(null);

  // Un popover se cierra con Escape y al pulsar fuera; es lo que espera
  // cualquiera que lo haya abierto. Se escucha en `mousedown` y no en `click`
  // para que el panel se quite al empezar el gesto, no al soltar.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="filter-bar">
      <div className="filter-bar-row">
        {lead && <div className="filter-bar-lead">{lead}</div>}

        {search && (
          <input
            className="input search"
            type="search"
            placeholder={search.placeholder}
            aria-label={search.placeholder ?? 'Buscar'}
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
          />
        )}

        <div className="filter-pop" ref={root}>
          <button
            type="button"
            className={`btn btn-ghost filter-toggle${open ? ' is-open' : ''}${chips.length > 0 ? ' has-filters' : ''}`}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 5h18l-7 8v6l-4 2v-8z" />
            </svg>
            Filtros
            {chips.length > 0 && <span className="filter-count">{chips.length}</span>}
          </button>

          {open && (
            <div className="filter-panel fadeIn" role="group" aria-label="Filtros">
              <div className="filter-panel-grid">{children}</div>
              {chips.length > 0 && (
                <div className="filter-panel-foot">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={onClearAll}>
                    Limpiar filtros
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Con el panel cerrado, esto es lo único que dice qué se está aplicando. */}
      {chips.length > 0 && (
        <div className="filter-chips">
          {chips.map((chip) => (
            <span className="chip filter-chip" key={chip.label}>
              {chip.label}
              <button
                type="button"
                className="filter-chip-x"
                aria-label={`Quitar filtro ${chip.label}`}
                onClick={chip.onClear}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
                  <path d="M6 6 18 18M18 6 6 18" />
                </svg>
              </button>
            </span>
          ))}
          <button type="button" className="filter-clear" onClick={onClearAll}>Limpiar</button>
        </div>
      )}
    </div>
  );
}
