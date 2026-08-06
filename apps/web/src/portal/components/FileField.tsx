/**
 * FileField — selector de archivo del portal.
 *
 * El `<input type="file">` con la clase `.input` se ve mal y no hay forma de
 * arreglarlo por CSS: el botón lo pinta el navegador (cada uno el suyo), no se
 * alinea dentro de la caja de 46px y el nombre del archivo se corta sin avisar.
 * Aquí el input real queda oculto pero VIVO —sigue en el formulario y sigue
 * recibiendo el foco del teclado— y lo que se ve es una zona donde se puede
 * soltar el archivo o hacer clic, y ya elegido, su nombre, su tamaño y un botón
 * para quitarlo.
 *
 * El componente NO valida: quien lo usa decide si el archivo entra (el catálogo
 * de `@courier/shared` es el mismo que aplica la API) y responde volviendo a
 * pasar `file` en null si lo rechaza. El input nativo se vacía solo cuando eso
 * pasa, así que quien lo usa no necesita tocar ninguna ref.
 */
import { useEffect, useRef, useState } from 'react';

interface Props {
  id: string;
  label: string;
  /** Nota bajo el campo: qué formatos se aceptan y para qué sirve el archivo. */
  hint?: React.ReactNode;
  /** Atributo `accept` del input: orienta el selector, no obliga. */
  accept?: string;
  file: File | null;
  /** `null` cuando se quita el archivo elegido. */
  onPick: (file: File | null) => void;
  disabled?: boolean;
}

/** Tamaño legible. Un decimal solo mientras la cifra sea corta. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function FileField({ id, label, hint, accept, file, onPick, disabled }: Props) {
  const [dragging, setDragging] = useState(false);
  /** El valor del input nativo no lo controla React: hay que vaciarlo a mano. */
  const input = useRef<HTMLInputElement>(null);

  // Sin archivo elegido, el input tiene que quedar vacío de verdad: si no,
  // volver a elegir EL MISMO archivo que se acaba de quitar (o que se rechazó)
  // no dispara `change` y el campo se queda mudo.
  useEffect(() => {
    if (!file && input.current) input.current.value = '';
  }, [file]);

  function drop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    onPick(e.dataTransfer.files?.[0] ?? null);
  }

  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div
        className={`file-field${file ? ' has-file' : ''}${dragging ? ' is-drag' : ''}${disabled ? ' is-disabled' : ''}`}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <input
          id={id}
          ref={input}
          className="file-field-input"
          type="file"
          accept={accept}
          disabled={disabled}
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />

        {file ? (
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
              {/* Un `label` y no un botón: abrir el selector es justo lo que hace
                  el input oculto, y así no hace falta simular el clic. */}
              <label className="btn btn-ghost btn-sm" htmlFor={id}>Cambiar</label>
              <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={() => onPick(null)}>
                Quitar
              </button>
            </div>
          </div>
        ) : (
          <label className="file-field-empty" htmlFor={id}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M12 3v13" />
              <path d="m7 8 5-5 5 5" />
            </svg>
            <span className="file-field-cta">
              Arrastra el archivo o <span className="file-field-link">búscalo en tu equipo</span>
            </span>
          </label>
        )}
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}
