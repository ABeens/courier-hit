/**
 * Listado paginado del portal: UN solo sitio donde vive el ciclo de vida de
 * cualquier tabla o pila de fichas (filtros, pagina, carga, error, recarga).
 *
 * Antes cada pantalla repetia el mismo bloque de `useState` + `useCallback` +
 * `setTimeout` de 250 ms. Repetido seis veces, cada copia arrastraba los mismos
 * tres problemas:
 *
 *   1. Pedia el listado ENTERO. Ver `@courier/shared` (`http/pagination`).
 *   2. No cancelaba la peticion anterior. Con el debounce del buscador, dos
 *      respuestas podian llegar en orden distinto al que se pidieron y la lista
 *      acababa mostrando el resultado de una busqueda ya borrada.
 *   3. Solo distinguia "hay datos" de "no hay datos", asi que al recargar la
 *      pantalla se quedaba con lo viejo sin decir que estaba trabajando, y al
 *      entrar se quedaba en blanco sin decir que estaba cargando.
 *
 * Los dos estados de carga son distintos y se resuelven distinto:
 *   - `loading`  -> primera carga, no hay nada que enseñar: va esqueleto.
 *   - `refreshing` -> ya hay filas en pantalla: se atenuan y se marca actividad,
 *     pero NO se vacian. Vaciar en cada tecla del buscador es un parpadeo.
 */
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PAGE_SIZE, pageCount } from '@courier/shared';
import type { Page } from '@courier/shared';
import { ApiError, api } from './api';

/** Filtros de la pantalla. Lo vacio no viaja: un filtro sin poner no es un filtro. */
export type ListParams = Record<string, string | number | boolean | undefined>;

/**
 * Filtros -> query estable. Las claves se ordenan para que el mismo juego de
 * filtros produzca siempre la misma cadena: esa cadena ES la dependencia del
 * efecto, asi que el objeto de filtros puede recrearse en cada render sin
 * disparar peticiones de mas.
 */
function serialize(params: ListParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  search.sort();
  return search.toString();
}

export interface PagedList<T, Extra> {
  /** Respuesta completa (incluidos los contadores propios del endpoint). */
  data: (Page<T> & Extra) | null;
  /** Filas de la pagina actual; `[]` mientras no haya llegado nada. */
  items: T[];
  /** Total FILTRADO, el numero de la cabecera. 0 mientras no haya respuesta. */
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Va a una pagina concreta, recortada al rango valido. */
  goToPage: (page: number) => void;
  /** Primera carga: no hay nada en pantalla. */
  loading: boolean;
  /** Recarga con filas ya pintadas. */
  refreshing: boolean;
  error: string | null;
  setError: (message: string | null) => void;
  /** Vuelve a pedir la pagina actual (tras guardar, avanzar, asignar…). */
  reload: () => void;
}

export function usePagedList<T, Extra = unknown>(
  path: string,
  params: ListParams,
  options: { errorMessage: string; pageSize?: number; debounceMs?: number },
): PagedList<T, Extra> {
  const { errorMessage, pageSize = DEFAULT_PAGE_SIZE, debounceMs = 250 } = options;

  const query = serialize(params);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<(Page<T> & Extra) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * Cambiar un filtro devuelve a la primera pagina. Quedarse en la 7 de un
   * listado que tras filtrar tiene 2 da una pantalla vacia sin explicacion, que
   * es exactamente el sintoma de "faltan trámites" que ya cuesta caro con los
   * filtros escondidos. Se hace durante el render y no en un efecto para que la
   * peticion de la pagina vieja no llegue a salir.
   */
  const filterKey = useRef(query);
  if (filterKey.current !== query) {
    filterKey.current = query;
    setPage(1);
  }

  /**
   * Solo se espera cuando cambia un FILTRO, porque el buscador escribe letra a
   * letra. Pasar de pagina o recargar tras guardar responden a un gesto unico y
   * salen sin retardo: un pager que tarda un cuarto de segundo se siente roto.
   */
  const fetchedKey = useRef(query);

  useEffect(() => {
    const filtersChanged = fetchedKey.current !== query;
    fetchedKey.current = query;

    let cancelled = false;

    const run = async () => {
      setPending(true);
      const search = new URLSearchParams(query);
      search.set('page', String(page));
      search.set('pageSize', String(pageSize));
      try {
        const response = await api.get<Page<T> & Extra>(`${path}?${search.toString()}`);
        if (cancelled) return;
        setData(response);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : errorMessage);
      } finally {
        if (!cancelled) setPending(false);
      }
    };

    const timer = setTimeout(run, filtersChanged ? debounceMs : 0);
    /**
     * `cancelled` es la parte que no se puede quitar: la respuesta en vuelo se
     * descarta al cambiar los filtros o la pagina, asi que una respuesta lenta de
     * la busqueda anterior nunca pisa a la actual.
     */
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, query, page, pageSize, reloadToken, debounceMs, errorMessage]);

  const totalPages = data ? pageCount(data.total, data.pageSize) : 1;

  /**
   * La ultima pagina puede desaparecer bajo los pies: basta con entregar el unico
   * paquete que quedaba en ella. En vez de enseñar el hueco, se retrocede.
   */
  useEffect(() => {
    if (data && page > totalPages) setPage(totalPages);
  }, [data, page, totalPages]);

  return {
    data,
    items: data?.items ?? [],
    total: data?.total ?? 0,
    page,
    pageSize: data?.pageSize ?? pageSize,
    totalPages,
    goToPage: (next) => setPage(Math.min(Math.max(1, next), totalPages)),
    loading: pending && data === null,
    refreshing: pending && data !== null,
    error,
    setError,
    reload: () => setReloadToken((token) => token + 1),
  };
}
