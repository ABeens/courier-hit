/**
 * Acceso a datos de la definicion de rutas. La asignacion es un upsert por
 * codigo de distrito (PK), asi asignar y editar comparten camino.
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { districtRoutes } from './district-route.schema';

const columns = {
  districtCode: districtRoutes.districtCode,
  routeNumber: districtRoutes.routeNumber,
  updatedAt: districtRoutes.updatedAt,
};

export const routesRepo = {
  /** Todas las asignaciones distrito -> ruta, ordenadas por numero de ruta. */
  async list() {
    return db.select(columns).from(districtRoutes).orderBy(asc(districtRoutes.routeNumber));
  },

  /** Asigna o actualiza (upsert) la ruta de un distrito. */
  async upsert(districtCode: string, routeNumber: number) {
    const [row] = await db
      .insert(districtRoutes)
      .values({ districtCode, routeNumber })
      .onConflictDoUpdate({
        target: districtRoutes.districtCode,
        set: { routeNumber, updatedAt: new Date() },
      })
      .returning(columns);
    if (!row) throw new Error('No se pudo asignar la ruta.');
    return row;
  },

  /** Quita la asignacion de un distrito. Devuelve null si no existia. */
  async remove(districtCode: string) {
    const [row] = await db
      .delete(districtRoutes)
      .where(eq(districtRoutes.districtCode, districtCode))
      .returning({ districtCode: districtRoutes.districtCode });
    return row ?? null;
  },
};
