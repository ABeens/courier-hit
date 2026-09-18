/**
 * OptionPicker: selector de opciones ya cargadas, al estilo Chosen.
 *
 * Cerrado se lee como un `<select>` (la opcion puesta y su flecha). Al abrirlo
 * aparece un panel con SU PROPIO buscador arriba y la lista completa debajo: se
 * ve todo sin escribir nada, y escribir solo recorta. Es el hermano en memoria
 * de `ClientPicker`, que busca en la API; aqui las opciones llegan por props y
 * el filtro es local.
 *
 * Cuatro decisiones que se notan al usarlo:
 *   - El filtro IGNORA tildes y mayusculas ("permiso" encuentra "Permisos de
 *     Importación"), busca tambien en el detalle de la opcion (asi `13%` o `$5`
 *     encuentran el concepto por su valor) y resalta el trozo que coincide.
 *   - Al abrir, la opcion ya elegida arranca activa: abrir y pulsar Enter no
 *     cambia nada. Al escribir, la activa pasa a ser la primera coincidencia.
 *   - El panel ABRE HACIA ARRIBA. El picker se usa en filas de tabla dentro de
 *     un modal, donde lo que hay debajo es el final de la tabla y el pie con los
 *     botones: cayendo hacia abajo se sale de la caja o tapa justo lo que se
 *     acaba de agregar. Solo cae hacia abajo si arriba no queda sitio util.
 *   - El panel se pinta en el `body` (portal) y en posicion fija. Dentro de una
 *     tabla con scroll propio (`.table-wrap`) cualquier caja absoluta se
 *     recortaria, y un desplegable a medias no sirve de nada.
 *
 * Teclado: en el campo, Enter / Espacio / flecha abajo abren. En el panel,
 * flechas para moverse, Enter para elegir, Esc para cerrar (sin cerrar el modal
 * de fondo) y Tab para salir. Al cerrarse, el foco vuelve al campo.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export interface PickerOption {
  /** Valor que se devuelve al elegir. */
  value: string;
  label: string;
  /** Aclaracion a la derecha de la etiqueta (p. ej. el valor del catalogo). */
  detail?: string | null;
}

interface Props {
  id?: string;
  /** Valor elegido; '' = ninguno. */
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Texto del campo cuando no hay nada elegido. */
  placeholder?: string;
  /** Nombre accesible del campo: en una tabla no hay `<label>` que lo nombre. */
  ariaLabel?: string;
  /** Texto del buscador del panel. */
  searchPlaceholder?: string;
  /** Pie del panel cuando el filtro no deja nada. */
  emptyNote?: string;
}

/** Separacion entre el campo y el panel, y aire minimo contra el borde de la ventana. */
const PANEL_GAP = 6;
const PANEL_MARGIN = 12;
/** Alto del panel: el maximo al que aspira y el minimo con el que sigue siendo util. */
const PANEL_MAX = 320;
const PANEL_MIN = 180;

/** Sin tildes y en minusculas: asi "permiso" encuentra "Permisos de Importación". */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * La etiqueta con el trozo que coincide resaltado.
 *
 * El indice se busca sobre el texto plegado, que conserva la posicion de cada
 * caracter del original (en espanol, plegar una letra acentuada da una letra),
 * asi que sirve para cortar la etiqueta de verdad y no la normalizada.
 */
function highlight(label: string, term: string) {
  if (term === '') return label;
  const at = fold(label).indexOf(fold(term));
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark className="picker-hit">{label.slice(at, at + term.length)}</mark>
      {label.slice(at + term.length)}
    </>
  );
}

export function OptionPicker({
  id,
  value,
  options,
  onChange,
  disabled,
  placeholder = 'Elige una opción',
  ariaLabel,
  searchPlaceholder = 'Escribe para filtrar…',
  emptyNote = 'Ninguna opción coincide.',
}: Props) {
  const listId = useId();
  const fieldRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  /**
   * Donde pintar el panel, en coordenadas de ventana (vive en el body). Se ancla
   * por abajo (`bottom`) cuando abre hacia arriba, para que crezca en esa
   * direccion sin tener que medirlo antes.
   */
  const [box, setBox] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);

  const selected = options.find((o) => o.value === value) ?? null;
  const term = query.trim();
  const filtered =
    term === ''
      ? options
      : options.filter((o) => fold(`${o.label} ${o.detail ?? ''}`).includes(fold(term)));

  const place = useCallback(() => {
    const el = fieldRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const above = r.top - PANEL_MARGIN;
    const below = window.innerHeight - r.bottom - PANEL_MARGIN;
    /**
     * Hacia arriba es la direccion por defecto; se cae hacia abajo solo cuando
     * arriba no cabe un panel util y abajo hay mas hueco. Asi el criterio no
     * depende de haber medido el panel: basta el hueco de cada lado.
     */
    const up = above >= PANEL_MIN || above >= below;
    setBox({
      left: r.left,
      width: r.width,
      top: up ? undefined : r.bottom + PANEL_GAP,
      bottom: up ? window.innerHeight - r.top + PANEL_GAP : undefined,
      maxHeight: Math.max(PANEL_MIN, Math.min(PANEL_MAX, (up ? above : below) - PANEL_GAP)),
    });
  }, []);

  // Se mide antes de pintar para que el panel no aparezca en el sitio anterior.
  useLayoutEffect(() => {
    if (!open) return;
    place();
    searchRef.current?.focus();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    // El panel sigue al campo: el modal y la tabla pueden desplazarse debajo
    // (scroll en captura, que los contenedores no lo propagan).
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    /** Pulsar fuera del campo y del panel cierra sin elegir. */
    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (fieldRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
      setQuery('');
      setActive(-1);
    };
    document.addEventListener('mousedown', onOutside);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('mousedown', onOutside);
    };
  }, [open, place]);

  // La fila activa se mantiene a la vista al moverse con el teclado.
  useEffect(() => {
    if (active < 0 || !listRef.current) return;
    const el = listRef.current.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function openPanel() {
    if (disabled) return;
    setQuery('');
    // Lo que ya esta puesto arranca activo: abrir y pulsar Enter no lo cambia.
    setActive(options.findIndex((o) => o.value === value));
    setOpen(true);
  }

  function closePanel() {
    setOpen(false);
    setQuery('');
    setActive(-1);
    fieldRef.current?.focus();
  }

  function choose(option: PickerOption) {
    onChange(option.value);
    closePanel();
  }

  function onFieldKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPanel();
    }
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length) setActive((i) => (i + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length) setActive((i) => (i <= 0 ? filtered.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault(); // no enviar el formulario al elegir
      // Con un solo resultado, Enter lo toma sin obligar a bajar con la flecha.
      const pick = filtered[active] ?? (filtered.length === 1 ? filtered[0] : undefined);
      if (pick) choose(pick);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // que no cierre el modal de fondo
      closePanel();
    } else if (e.key === 'Tab') {
      closePanel();
    }
  }

  return (
    <div className="picker">
      <button
        type="button"
        id={id}
        ref={fieldRef}
        className={`picker-field${selected ? '' : ' is-empty'}${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? closePanel() : openPanel())}
        onKeyDown={onFieldKeyDown}
      >
        <span className="picker-value">{selected?.label ?? placeholder}</span>
        {selected?.detail && <span className="picker-detail">{selected.detail}</span>}
        <span className="picker-caret" aria-hidden="true">
          <Icon name="chevD" size={16} />
        </span>
      </button>

      {open &&
        box &&
        createPortal(
          <div
            className="picker-panel"
            ref={panelRef}
            style={{
              position: 'fixed',
              left: box.left,
              width: box.width,
              top: box.top,
              bottom: box.bottom,
              maxHeight: box.maxHeight,
            }}
          >
            <div className="picker-search">
              <Icon name="search" size={15} />
              <input
                ref={searchRef}
                className="input"
                type="text"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
                aria-label={ariaLabel ? `Filtrar ${ariaLabel.toLowerCase()}` : 'Filtrar opciones'}
                autoComplete="off"
                spellCheck={false}
                placeholder={searchPlaceholder}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  // Al filtrar, la primera coincidencia queda lista para Enter.
                  setActive(0);
                }}
                onKeyDown={onSearchKeyDown}
              />
            </div>

            <ul id={listId} ref={listRef} role="listbox" className="picker-list">
              {filtered.map((o, i) => (
                <li
                  key={o.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  className={`picker-item${i === active ? ' is-active' : ''}${
                    o.value === value ? ' is-selected' : ''
                  }`}
                  // mousedown y no click: el panel se cierra al pulsar fuera, y
                  // con click el orden de eventos ya habria movido el foco.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(o);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="picker-item-label">{highlight(o.label, term)}</span>
                  {o.detail && <span className="picker-item-detail">{o.detail}</span>}
                </li>
              ))}
            </ul>

            {filtered.length === 0 && <div className="picker-note">{emptyNote}</div>}
          </div>,
          document.body,
        )}
    </div>
  );
}
