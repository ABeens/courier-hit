/**
 * Paginacion de listados: UN solo contrato para toda la API y todo el portal.
 *
 * Por que existe. Los listados del panel (tramites, casilleros, cola de entrega,
 * enlaces) devolvian TODO lo que hiciera match con los filtros. Con el volumen de
 * un courier eso deja de funcionar por tres sitios a la vez: la consulta de
 * tramites lleva una subconsulta correlacionada por fila para los abonos, el DTO
 * ronda los treinta campos, y el listado se vuelve a pedir en cada tecla del
 * buscador. Nada de eso se arregla enseñando menos filas en el navegador: hay que
 * pedir menos.
 *
 * Se elige OFFSET y no cursor a proposito:
 *
 *   - Las pantallas enseñan el TOTAL en la cabecera ("1.240 tramites"), asi que
 *     el `count` hay que pagarlo igual. Con eso pagado, el offset no cuesta nada
 *     de mas frente a un cursor.
 *   - Nadie navega a la pagina 900 en un tablero operativo: se filtra por estado,
 *     por rango de fechas o se busca una guia. La degradacion del offset profundo
 *     no es un patron de uso real aqui.
 *   - Un cursor opaco impide "ir a la pagina N" y se rompe en cuanto se quiera
 *     ordenar por otra columna.
 *
 * REGLA QUE NO SE PUEDE ROMPER: todo listado paginado ordena por una clave
 * DETERMINISTA, es decir con desempate por `id`. Sin el, dos filas con la misma
 * fecha pueden intercambiarse entre peticiones y la misma fila sale en dos
 * paginas mientras otra no sale en ninguna. Y aqui los empates estan
 * garantizados, no son teoricos: la sincronizacion con el proveedor y la
 * recepcion insertan lotes dentro de una transaccion, y `now()` devuelve el mismo
 * instante para toda la transaccion en Postgres.
 */
import { z } from 'zod';

/** Filas por pagina cuando el cliente no pide otra cosa. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Techo duro del tamaño de pagina. Es la mitad util de la paginacion: sin el,
 * `?pageSize=999999` devuelve la tabla entera y estamos donde empezamos.
 */
export const MAX_PAGE_SIZE = 100;

/**
 * `page` y `pageSize` de la query. Se fusiona (`.merge`) con los filtros propios
 * de cada listado, asi que un endpoint nuevo hereda el contrato sin repetirlo.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce
    .number({ invalid_type_error: 'La página debe ser un número.' })
    .int('La página debe ser un número entero.')
    .min(1, 'La página empieza en 1.')
    .default(1),
  pageSize: z.coerce
    .number({ invalid_type_error: 'El tamaño de página debe ser un número.' })
    .int('El tamaño de página debe ser un número entero.')
    .min(1, 'El tamaño de página debe ser al menos 1.')
    .max(MAX_PAGE_SIZE, `El tamaño de página no puede pasar de ${MAX_PAGE_SIZE}.`)
    .default(DEFAULT_PAGE_SIZE),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Sobre de respuesta de un listado paginado. Conserva `items` para no romper a
 * ningun consumidor: lo que se agrega es el contexto que la pagina sola no da
 * (cuantos hay en total y que trozo se esta mirando).
 *
 * `total` es el total FILTRADO, no el de la tabla: es el numero que la cabecera
 * enseña y el que decide cuantas paginas hay.
 */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Traduce la pagina pedida a `LIMIT`/`OFFSET` de SQL. */
export function toSlice(query: PaginationQuery): { limit: number; offset: number } {
  return { limit: query.pageSize, offset: (query.page - 1) * query.pageSize };
}

/** Arma el sobre a partir de las filas de la pagina y el total filtrado. */
export function paged<T>(items: T[], total: number, query: PaginationQuery): Page<T> {
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * Cuantas paginas hay. Un listado vacio tiene UNA pagina (la que se esta
 * mirando, vacia) y no cero: con cero, el pie de paginacion diria "página 1 de 0".
 */
export function pageCount(total: number, pageSize: number): number {
  return total <= 0 ? 1 : Math.ceil(total / pageSize);
}

/** Indice de la primera fila de la pagina, en base 1, para el "N-M de T". */
export function firstRowIndex(page: number, pageSize: number): number {
  return (page - 1) * pageSize + 1;
}
