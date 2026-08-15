/**
 * Contrato de la definicion de rutas: el administrador asigna UN numero de ruta
 * operativa a una zona (Provincia > Canton > Distrito). Varias zonas pueden
 * compartir el mismo numero (una ruta cubre varios distritos).
 *
 * DOS NIVELES, UNO HEREDA DEL OTRO. La asignacion se puede hacer a un canton
 * entero o a un distrito suelto:
 *   - la ruta del CANTON es el valor por defecto de todos sus distritos;
 *   - la ruta del DISTRITO es una excepcion y siempre manda sobre la del canton.
 * Asi el administrador marca "todo Escazu es la ruta 1" con una sola accion y
 * luego, si hace falta, entra a un distrito concreto a corregirlo sin que la
 * proxima reasignacion del canton se lleve por delante esa correccion.
 *
 * Nada se materializa: el canton no escribe filas de distrito. Lo que se guarda
 * son las dos asignaciones y la ruta efectiva se RESUELVE al leer (en SQL con un
 * coalesce, en la web con `resolveDistrictRoute`). Quitar la excepcion de un
 * distrito lo devuelve solo a la ruta de su canton.
 *
 * El catalogo territorial es estatico y vive en `./costa-rica`; aqui solo se
 * modela lo que se persiste. La web mezcla el catalogo con estas asignaciones
 * para pintar la pantalla.
 */
import { z } from 'zod';

/** Numero de ruta operativa: entero positivo. */
export const routeNumberSchema = z
  .number({ invalid_type_error: 'El número de ruta debe ser numérico.' })
  .int('El número de ruta debe ser un entero.')
  .positive('El número de ruta debe ser mayor que cero.')
  .max(9999, 'El número de ruta es demasiado grande.');

// Los dos niveles se asignan con el mismo cuerpo; la regla del numero se escribe
// una sola vez y cada nivel conserva su propio tipo.
const routeAssignmentShape = { routeNumber: routeNumberSchema };

/** Asignar o actualizar (upsert) la ruta de un distrito. */
export const upsertDistrictRouteSchema = z.object(routeAssignmentShape);
export type UpsertDistrictRouteInput = z.infer<typeof upsertDistrictRouteSchema>;

/** Asignar o actualizar (upsert) la ruta de un canton entero. */
export const upsertCantonRouteSchema = z.object(routeAssignmentShape);
export type UpsertCantonRouteInput = z.infer<typeof upsertCantonRouteSchema>;

/** Fila de asignacion distrito -> ruta que devuelve la API. */
export interface DistrictRouteDto {
  districtCode: string;
  routeNumber: number;
  updatedAt: string;
}

/** Fila de asignacion canton -> ruta que devuelve la API. */
export interface CantonRouteDto {
  cantonCode: string;
  routeNumber: number;
  updatedAt: string;
}

/**
 * De donde sale la ruta efectiva de un distrito: `district` es una excepcion
 * puesta a mano sobre ese distrito, `canton` es el valor heredado del canton.
 */
export type RouteSource = 'district' | 'canton';

/** Ruta que aplica de verdad a un distrito, con el nivel del que sale. */
export interface EffectiveDistrictRoute {
  routeNumber: number;
  source: RouteSource;
}

/**
 * Resuelve la ruta efectiva de un distrito: su excepcion propia si la tiene y,
 * si no, la ruta de su canton. `null` cuando no hay ninguna de las dos.
 *
 * Es la MISMA regla que la API aplica en SQL (`coalesce(distrito, canton)`); si
 * cambia el orden de precedencia tiene que cambiar en los dos sitios.
 */
export function resolveDistrictRoute(
  district: { districtCode: string; cantonCode: string },
  districtRoutes: ReadonlyMap<string, number>,
  cantonRoutes: ReadonlyMap<string, number>,
): EffectiveDistrictRoute | null {
  const own = districtRoutes.get(district.districtCode);
  if (own != null) return { routeNumber: own, source: 'district' };
  const inherited = cantonRoutes.get(district.cantonCode);
  if (inherited != null) return { routeNumber: inherited, source: 'canton' };
  return null;
}
