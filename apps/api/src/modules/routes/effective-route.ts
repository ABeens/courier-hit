/**
 * La ruta operativa de una direccion, para quien no es el modulo de rutas.
 *
 * Hay dos niveles de asignacion (ver `@courier/shared` -> `geo/routes`): la ruta
 * del canton vale para todos sus distritos y la del distrito es una excepcion
 * que manda sobre ella. Ningun lector debe reimplementar esa precedencia: esto
 * la escribe una vez, como columna y como join, y el listado de tramites, la
 * cola del mensajero y los reportes la usan tal cual.
 *
 * La ruta NO se copia a la fila del tramite: si el administrador reasigna la
 * ruta de un distrito o de un canton, los tramites en curso lo reflejan sin
 * migrar datos.
 */
import { eq, sql } from 'drizzle-orm';
import { clients } from '../auth/auth.schema';
import { cantonRoutes } from './canton-route.schema';
import { districtRoutes } from './district-route.schema';

/**
 * Columna de SELECT con el numero de ruta que aplica de verdad a la direccion
 * del cliente de la fila. Sirve tambien para filtrar y ordenar (`eq(...)`,
 * `asc(...)`), asi que el filtro por ruta ve lo mismo que la columna mostrada.
 *
 * Solo funciona en consultas que hayan encadenado los dos joins de abajo: sin
 * ellos las tablas no estan en el FROM.
 */
export const effectiveRouteNumber = sql<
  number | null
>`coalesce(${districtRoutes.routeNumber}, ${cantonRoutes.routeNumber})`;

/**
 * Condiciones de los dos LEFT JOIN que exige `effectiveRouteNumber`, contra la
 * direccion del casillero. Cada repo los encadena a su consulta (Drizzle tipa el
 * resultado de cada join, por eso no se envuelven en un helper generico); esto
 * mantiene en un solo sitio POR QUE columna se une cada tabla.
 *
 * Los dos van en LEFT: una direccion sin ruta en ninguno de los dos niveles no
 * puede desaparecer del listado, tiene que salir con "Sin ruta".
 */
export const districtRouteJoin = eq(clients.districtCode, districtRoutes.districtCode);
export const cantonRouteJoin = eq(clients.cantonCode, cantonRoutes.cantonCode);
