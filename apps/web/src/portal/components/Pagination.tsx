/**
 * Pie de paginacion de un listado del portal.
 *
 * Dos piezas y ninguna decorativa:
 *   - EL RANGO ("51-100 de 1.240"). Sin el, una pagina de cincuenta fichas no
 *     dice si es todo lo que hay o el principio de mil, que es justo la duda que
 *     antes no existia porque llegaba el listado entero.
 *   - LOS NUMEROS. Un "anterior / siguiente" a secas obliga a pulsar veinte veces
 *     para llegar al final de una cola; con los numeros se salta.
 *
 * No se pinta con una sola pagina: un pie que dice "página 1 de 1" es ruido.
 */

/** Numeros a enseñar, con huecos donde se salta. Siempre la primera y la ultima. */
function pageItems(page: number, totalPages: number): (number | 'gap')[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);

  const around = [page - 1, page, page + 1].filter((n) => n > 1 && n < totalPages);
  const items: (number | 'gap')[] = [1];

  if (around[0] !== undefined && around[0] > 2) items.push('gap');
  items.push(...around);
  const last = around[around.length - 1];
  if (last === undefined || last < totalPages - 1) items.push('gap');
  items.push(totalPages);

  return items;
}

interface Props {
  page: number;
  pageSize: number;
  /** Total FILTRADO, no el de la tabla: es lo que el usuario está recorriendo. */
  total: number;
  totalPages: number;
  onPage: (page: number) => void;
  /**
   * Hay una peticion en vuelo. El pie no se esconde (la lista sigue ahi), pero se
   * bloquea: encadenar clics en "siguiente" mientras carga pide paginas que se
   * van a descartar.
   */
  busy?: boolean;
  /** Cómo se llama lo que se lista, en plural: "trámites", "casilleros". */
  noun: string;
}

export function Pagination({ page, pageSize, total, totalPages, onPage, busy, noun }: Props) {
  if (totalPages <= 1) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const format = (n: number) => n.toLocaleString('es-CR');

  return (
    <nav className="pager" aria-label={`Paginación de ${noun}`}>
      <div className="pager-range">
        {format(first)}-{format(last)} de {format(total)} {noun}
      </div>

      <div className="pager-pages">
        <button
          type="button"
          className="btn btn-ghost btn-sm pager-step"
          disabled={busy || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="m14 6-6 6 6 6" />
          </svg>
          Anterior
        </button>

        {pageItems(page, totalPages).map((item, index) =>
          item === 'gap' ? (
            // eslint-disable-next-line react/no-array-index-key -- el hueco no tiene identidad propia
            <span className="pager-gap" key={`gap-${index}`} aria-hidden="true">
              …
            </span>
          ) : (
            <button
              type="button"
              key={item}
              className={`pager-num${item === page ? ' is-current' : ''}`}
              aria-current={item === page ? 'page' : undefined}
              aria-label={`Página ${item}`}
              disabled={busy}
              onClick={() => onPage(item)}
            >
              {item}
            </button>
          ),
        )}

        <button
          type="button"
          className="btn btn-ghost btn-sm pager-step"
          disabled={busy || page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          Siguiente
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="m10 6 6 6-6 6" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
