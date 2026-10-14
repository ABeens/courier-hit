/**
 * FilesField: selector de VARIOS archivos del portal, hermano de `FileField`.
 *
 * Mismo aspecto y mismas reglas que el de un archivo (input real oculto pero
 * vivo, zona para soltar o hacer clic), con dos diferencias: lo que se elige SE
 * SUMA a la lista en vez de reemplazarla, y cada archivo elegido trae su propio
 * botón para quitarlo. La zona de arrastre desaparece al llegar al tope.
 *
 * Tampoco valida: quien lo usa recibe en `onAdd` lo que el usuario eligió,
 * decide qué entra (el catálogo de `@courier/shared` es el mismo que aplica la
 * API) y cuánto cabe, y es dueño de la lista.
 */
import { useRef, useState } from 'react';
import { formatSize } from './FileField';

interface Props {
  id: string;
  label: string;
  /** Nota bajo el campo: qué formatos se aceptan y para qué sirven los archivos. */
  hint?: React.ReactNode;
  /** Atributo `accept` del input: orienta el selector, no obliga. */
  accept?: string;
  files: File[];
  /** Cuántos archivos admite el campo; sin sitio, la zona de arrastre se oculta. */
  max: number;
  /** Lo que el usuario acaba de elegir o soltar, sin filtrar. */
  onAdd: (files: File[]) => void;
  /** Quita el archivo de esa posición. */
  onRemove: (index: number) => void;
  disabled?: boolean;
}

export function FilesField({ id, label, hint, accept, files, max, onAdd, onRemove, disabled }: Props) {
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const full = files.length >= max;

  /**
   * El input se vacía después de cada elección: sin eso, volver a elegir EL
   * MISMO archivo (el que se acaba de quitar o el que se rechazó) no dispara
   * `change` y el campo se queda mudo.
   */
  function add(list: FileList | null) {
    const picked = Array.from(list ?? []);
    if (input.current) input.current.value = '';
    if (picked.length > 0) onAdd(picked);
  }

  function drop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (disabled || full) return;
    add(e.dataTransfer.files);
  }

  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {label}
        {files.length > 0 && <span className="files-field-count"> ({files.length} de {max})</span>}
      </label>

      {files.length > 0 && (
        <ul className="files-field-list">
          {files.map((file, i) => (
            <li className="file-field has-file" key={`${file.name}-${file.size}-${file.lastModified}-${i}`}>
              <div className="file-field-picked">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5" />
                </svg>
                <div className="file-field-meta">
                  <span className="file-field-name" title={file.name}>{file.name}</span>
                  <span className="file-field-size">{formatSize(file.size)}</span>
                </div>
                <div className="file-field-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={disabled}
                    onClick={() => onRemove(i)}
                    aria-label={`Quitar ${file.name}`}
                  >
                    Quitar
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* El input sigue montado aunque la lista esté llena: así el `label` del
          campo no apunta a la nada. Solo la zona para añadir desaparece. */}
      <div
        className={`file-field${dragging ? ' is-drag' : ''}${disabled ? ' is-disabled' : ''}`}
        hidden={full}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <input
          id={id}
          ref={input}
          className="file-field-input"
          type="file"
          multiple
          accept={accept}
          disabled={disabled || full}
          onChange={(e) => add(e.target.files)}
        />
        <label className="file-field-empty" htmlFor={id}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M12 3v13" />
            <path d="m7 8 5-5 5 5" />
          </svg>
          <span className="file-field-cta">
            {files.length === 0 ? 'Arrastra los archivos o ' : 'Añade otro: arrástralo o '}
            <span className="file-field-link">búscalo en tu equipo</span>
          </span>
        </label>
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}
