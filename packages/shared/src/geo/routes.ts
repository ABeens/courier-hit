/**
 * Contrato de la definicion de rutas: a cada distrito (Provincia > Canton >
 * Distrito) el administrador le asigna UN numero de ruta operativa. Varios
 * distritos pueden compartir el mismo numero (una ruta cubre varios distritos).
 *
 * El catalogo territorial es estatico y vive en `./costa-rica`; aqui solo se
 * modela lo que se persiste: la asignacion distrito -> numero de ruta. La web
 * mezcla el catalogo con estas asignaciones para pintar la pantalla.
 */
import { z } from 'zod';

/** Numero de ruta operativa: entero positivo. */
export const routeNumberSchema = z
  .number({ invalid_type_error: 'El número de ruta debe ser numérico.' })
  .int('El número de ruta debe ser un entero.')
  .positive('El número de ruta debe ser mayor que cero.')
  .max(9999, 'El número de ruta es demasiado grande.');

/** Asignar o actualizar (upsert) la ruta de un distrito. */
export const upsertDistrictRouteSchema = z.object({ routeNumber: routeNumberSchema });
export type UpsertDistrictRouteInput = z.infer<typeof upsertDistrictRouteSchema>;

/** Fila de asignacion distrito -> ruta que devuelve la API. */
export interface DistrictRouteDto {
  districtCode: string;
  routeNumber: number;
  updatedAt: string;
}
