/**
 * ClientPicker: buscador de casillero con desplegable (combobox).
 *
 * Un solo campo hace las dos cosas: se escribe para filtrar y se elige de la
 * lista que aparece debajo. Antes eran dos controles (un buscador y un
 * `<select>` aparte) y en el uso diario obligaba a mirar dos sitios y a hacer
 * dos gestos por cada trámite.
 *
 * La busqueda va a la API (`/clients?q=`), que filtra por nombre, casillero,
 * cedula y correo, con debounce para no pedir en cada tecla y con un tope de
 * resultados: con unos pocos miles de casilleros pintar todo es inservible.
 * Si sobran, se dice al pie de la lista.
 *
 * Teclado: flechas para moverse, Enter para elegir, Esc para cerrar (sin cerrar
 * el modal de fondo). Al elegir, el campo muestra la etiqueta del cliente y
 * ofrece una X para volver a buscar.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Page } from '@courier/shared';
import { api } from '../lib/api';
import { Icon } from './Icon';

export interface ClientOption {
  id: string;
  code: string;
  name: string;
  idNumber: string;
}

/** Cuantos casilleros se pintan como maximo por busqueda. */
const CLIENT_OPTIONS = 50;
const DEBOUNCE_MS = 250;

interface Props {
  id: string;
  /** Id del cliente elegido ('' = ninguno). */
  value: string;
  onChange: (clientId: string, client: ClientOption | null) => void;
  disabled?: boolean;
  placeholder?: string;
}

const labelOf = (c: ClientOption) => `${c.code} · ${c.name} (${c.idNumber})`;

export function ClientPicker({
  id,
  value,
  onChange,
  disabled,
  placeholder = 'Buscar por nombre, casillero o cédula…',
}: Props) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Numero de la ultima peticion lanzada, para descartar respuestas viejas. */
  const requestSeq = useRef(0);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ClientOption | null>(null);
  const [options, setOptions] = useState<ClientOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  // Si el padre vacia el valor (p. ej. tras guardar), el campo vuelve a limpio.
  useEffect(() => {
    if (value === '' && selected) {
      setSelected(null);
      setQuery('');
    }
  }, [value, selected]);

  const search = useCallback(async (term: string) => {
    const seq = ++requestSeq.current;
    const params = new URLSearchParams({ pageSize: String(CLIENT_OPTIONS) });
    if (term.trim()) params.set('q', term.trim());
    setLoading(true);
    try {
      const res = await api.get<Page<ClientOption>>(`/clients?${params.toString()}`);
      if (seq !== requestSeq.current) return; // llego una mas nueva
      setOptions(res.items);
      setTotal(res.total);
    } catch {
      // el error se vera al enviar; no bloqueamos el formulario
      if (seq !== requestSeq.current) return;
      setOptions([]);
      setTotal(0);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // Busca con debounce mientras la lista esta abierta y no hay cliente elegido.
  useEffect(() => {
    if (!open || selected) return;
    const t = setTimeout(() => void search(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [open, selected, query, search]);

  // La fila activa se mantiene a la vista al moverse con el teclado.
  useEffect(() => {
    if (active < 0 || !listRef.current) return;
    const el = listRef.current.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function choose(c: ClientOption) {
    setSelected(c);
    setQuery(labelOf(c));
    setOpen(false);
    setActive(-1);
    onChange(c.id, c);
  }

  function clear() {
    setSelected(null);
    setQuery('');
    setOptions([]);
    setTotal(0);
    setActive(-1);
    onChange('', null);
    setOpen(true);
    inputRef.current?.focus();
  }

  function onInput(e: React.ChangeEvent<HTMLInputElement>) {
    // Escribir sobre un cliente ya elegido lo deselecciona: se vuelve a buscar.
    if (selected) {
      setSelected(null);
      onChange('', null);
    }
    setQuery(e.target.value);
    setActive(-1);
    setOpen(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (options.length) setActive((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (options.length) setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault(); // no enviar el formulario al elegir
      const pick = options[active] ?? (options.length === 1 ? options[0] : undefined);
      if (pick) choose(pick);
    } else if (e.key === 'Escape') {
      if (!open) return;
      e.stopPropagation(); // que no cierre el modal de fondo
      setOpen(false);
      setActive(-1);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  const showList = open && !selected && !disabled;
  const activeId = active >= 0 ? `${listId}-${active}` : undefined;

  return (
    <div className={`combo${selected ? ' has-value' : ''}`}>
      <input
        ref={inputRef}
        id={id}
        className="input"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={query}
        disabled={disabled}
        onChange={onInput}
        onKeyDown={onKeyDown}
        onFocus={() => { if (!selected) setOpen(true); }}
        onBlur={() => { setOpen(false); setActive(-1); }}
      />
      {selected ? (
        <button
          type="button"
          className="combo-clear"
          aria-label="Quitar cliente"
          title="Quitar cliente"
          disabled={disabled}
          onClick={clear}
        >
          <Icon name="x" size={16} />
        </button>
      ) : (
        <span className="combo-icon" aria-hidden="true">
          <Icon name={loading ? 'refresh' : 'search'} size={16} />
        </span>
      )}

      {showList && (
        // preventDefault en mousedown: pulsar dentro de la lista (una fila o su
        // barra de scroll) no debe quitarle el foco al input, porque el blur
        // cerraria la lista antes de que llegue el click.
        <div className="combo-menu" onMouseDown={(e) => e.preventDefault()}>
          <ul id={listId} ref={listRef} role="listbox" className="combo-list">
            {options.map((c, i) => (
              <li
                key={c.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`combo-item${i === active ? ' is-active' : ''}`}
                onMouseDown={() => choose(c)}
                onMouseEnter={() => setActive(i)}
              >
                <span className="combo-code mono">{c.code}</span>
                <span className="combo-name">{c.name}</span>
                <span className="combo-id">{c.idNumber}</span>
              </li>
            ))}
          </ul>
          {options.length === 0 && (
            <div className="combo-note">
              {loading ? 'Buscando…' : 'Ningún casillero coincide con la búsqueda.'}
            </div>
          )}
          {/* La lista esta recortada y hay que decirlo: quien no ve a su cliente
              tiene que saber que no es que no exista, sino que hay mas de los
              que caben. */}
          {total > options.length && (
            <div className="combo-note">
              {options.length} de {total.toLocaleString('es-CR')} casilleros. Afina la búsqueda
              para ver el resto.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
