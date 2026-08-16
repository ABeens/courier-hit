/**
 * Estados de carga de un listado. Son DOS y no uno, porque el usuario está en
 * dos sitios distintos:
 *
 *   - ESQUELETO (primera carga). No hay nada en pantalla. Se reserva el hueco con
 *     la forma real del listado en vez de dejar el blanco: así la página no da un
 *     salto al llegar los datos y se ve de una que lo que viene es una lista.
 *     Nunca lleva contenido inventado (ni números ni textos de ejemplo).
 *   - RECARGA (ya hay filas). Cambiar un filtro o pasar de página NO vacía la
 *     lista: se atenúa lo que hay y una barra fina marca la actividad. Vaciar en
 *     cada tecla del buscador es un parpadeo, y el parpadeo se lee como error.
 *
 * `aria-busy` en el contenedor y un texto para lector de pantalla: la atenuación
 * es una señal solo visual y quien no la ve necesita que se le diga.
 */

/** Barra fina de actividad, sobre el listado que se está refrescando. */
export function RefreshBar() {
  return (
    <div className="list-refresh-bar" role="status">
      <span className="sr-only">Actualizando el listado…</span>
    </div>
  );
}

/**
 * Contenedor de una lista que puede estar refrescándose. Mantiene las filas
 * visibles y quita el ratón de encima: pulsar "Avanzar" sobre una fila que está
 * a punto de ser reemplazada es un clic sobre el trámite equivocado.
 */
export function ListBody({ refreshing, children }: { refreshing: boolean; children: React.ReactNode }) {
  return (
    <div className={`list-body${refreshing ? ' is-refreshing' : ''}`} aria-busy={refreshing}>
      {refreshing && <RefreshBar />}
      {children}
    </div>
  );
}

/** Esqueleto de una pila de fichas (`.cards`). */
export function CardsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="cards" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="card-skeleton" key={i}>
          <div className="card-skeleton-head">
            <div className="skel-lines">
              <span className="skel-line w-code" />
              <span className="skel-line w-title" />
              <span className="skel-line w-sub" />
            </div>
            <span className="skel-pill" />
          </div>
          <div className="card-skeleton-body">
            <span className="skel-line w-field" />
            <span className="skel-line w-field" />
            <span className="skel-line w-field" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Esqueleto de una tabla (`.table`), con su cabecera real ya pintada encima. */
export function TableSkeleton({ rows = 6, cols }: { rows?: number; cols: number }) {
  return (
    <tbody aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}>
              <span className="skel-line w-cell" />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/**
 * Texto de "no hay nada". Solo se pinta con la carga TERMINADA: enseñar "No hay
 * trámites que coincidan" mientras la petición está en vuelo afirma algo que
 * todavía no se sabe, y es lo que hace que alguien limpie un filtro correcto.
 */
export function EmptyList({ loading, empty, children }: { loading: boolean; empty: boolean; children: React.ReactNode }) {
  if (loading || !empty) return null;
  return <div className="empty">{children}</div>;
}
