/**
 * Definicion de rutas (permiso routes.manage, solo admin).
 * Reglas:
 *   - el distrito debe existir en el catalogo territorial (no se confia en el
 *     codigo que manda el cliente).
 *   - asignar y editar son el mismo upsert; eliminar quita la asignacion.
 */
import { findDistrict } from '@courier/shared';
import type { UpsertDistrictRouteInput } from '@courier/shared';
import { RouteErrors } from '../../core/errors';
import { routesRepo } from './routes.repo';

export const routesService = {
  async list() {
    const items = await routesRepo.list();
    const distinctRoutes = new Set(items.map((i) => i.routeNumber)).size;
    return { items, counts: { assigned: items.length, routes: distinctRoutes } };
  },

  async assign(districtCode: string, input: UpsertDistrictRouteInput) {
    if (!findDistrict(districtCode)) throw RouteErrors.districtNotFound();
    return routesRepo.upsert(districtCode, input.routeNumber);
  },

  async remove(districtCode: string) {
    const removed = await routesRepo.remove(districtCode);
    if (!removed) throw RouteErrors.notFound();
    return { ok: true };
  },
};
