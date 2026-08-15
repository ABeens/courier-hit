/**
 * Definicion de rutas (permiso routes.manage, solo admin).
 * Reglas:
 *   - la zona debe existir en el catalogo territorial (no se confia en el
 *     codigo que manda el cliente).
 *   - asignar y editar son el mismo upsert; eliminar quita la asignacion.
 *   - la ruta del canton la heredan sus distritos y la del distrito manda sobre
 *     ella; la herencia se resuelve al leer, no se materializa (ver
 *     `@courier/shared` -> `geo/routes`).
 */
import { findCanton, findDistrict, getAllDistricts, resolveDistrictRoute } from '@courier/shared';
import type { UpsertCantonRouteInput, UpsertDistrictRouteInput } from '@courier/shared';
import { RouteErrors } from '../../core/errors';
import { routesRepo } from './routes.repo';

// El catalogo es estatico: se aplana una sola vez al cargar el modulo.
const ALL_DISTRICTS = getAllDistricts();

export const routesService = {
  /**
   * Las dos tablas de asignacion, mas el resumen ya resuelto: los contadores
   * cuentan distritos con ruta EFECTIVA (propia o heredada del canton), que es
   * lo que el administrador ve cubierto, no filas guardadas.
   */
  async list() {
    const [items, cantons] = await Promise.all([routesRepo.list(), routesRepo.listCantons()]);
    const districtMap = new Map(items.map((i) => [i.districtCode, i.routeNumber]));
    const cantonMap = new Map(cantons.map((c) => [c.cantonCode, c.routeNumber]));

    const distinctRoutes = new Set<number>();
    let assigned = 0;
    for (const district of ALL_DISTRICTS) {
      const effective = resolveDistrictRoute(district, districtMap, cantonMap);
      if (!effective) continue;
      assigned += 1;
      distinctRoutes.add(effective.routeNumber);
    }

    return { items, cantons, counts: { assigned, routes: distinctRoutes.size } };
  },

  async assign(districtCode: string, input: UpsertDistrictRouteInput) {
    if (!findDistrict(districtCode)) throw RouteErrors.districtNotFound();
    return routesRepo.upsert(districtCode, input.routeNumber);
  },

  /**
   * Asigna la ruta a un canton entero. No toca `district_routes`: los distritos
   * sin excepcion propia pasan a heredar este numero, y los que el administrador
   * cambio a mano siguen con el suyo.
   */
  async assignCanton(cantonCode: string, input: UpsertCantonRouteInput) {
    if (!findCanton(cantonCode)) throw RouteErrors.cantonNotFound();
    return routesRepo.upsertCanton(cantonCode, input.routeNumber);
  },

  /** Quita la excepcion del distrito: vuelve a heredar la ruta de su canton. */
  async remove(districtCode: string) {
    const removed = await routesRepo.remove(districtCode);
    if (!removed) throw RouteErrors.notFound();
    return { ok: true };
  },

  async removeCanton(cantonCode: string) {
    const removed = await routesRepo.removeCanton(cantonCode);
    if (!removed) throw RouteErrors.cantonRouteNotFound();
    return { ok: true };
  },
};
