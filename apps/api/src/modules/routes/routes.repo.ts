/**
 * Acceso a datos de la definicion de rutas, en sus dos niveles: la ruta del
 * canton (valor por defecto de sus distritos) y la del distrito (excepcion que
 * manda sobre la anterior). Cada asignacion es un upsert por codigo (PK), asi
 * asignar y editar comparten camino.
 *
 * Los dos niveles se guardan por separado a proposito: asignar un canton NO
 * escribe filas de distrito, para que una reasignacion posterior del canton no
 * pise las excepciones que el administrador puso a mano.
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { cantonRoutes } from './canton-route.schema';
import { districtRoutes } from './district-route.schema';

const districtColumns = {
  districtCode: districtRoutes.districtCode,
  routeNumber: districtRoutes.routeNumber,
  updatedAt: districtRoutes.updatedAt,
};

const cantonColumns = {
  cantonCode: cantonRoutes.cantonCode,
  routeNumber: cantonRoutes.routeNumber,
  updatedAt: cantonRoutes.updatedAt,
};

export const routesRepo = {
  /** Todas las asignaciones distrito -> ruta, ordenadas por numero de ruta. */
  async list() {
    return db.select(districtColumns).from(districtRoutes).orderBy(asc(districtRoutes.routeNumber));
  },

  /** Todas las asignaciones canton -> ruta, ordenadas por numero de ruta. */
  async listCantons() {
    return db.select(cantonColumns).from(cantonRoutes).orderBy(asc(cantonRoutes.routeNumber));
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
      .returning(districtColumns);
    if (!row) throw new Error('No se pudo asignar la ruta.');
    return row;
  },

  /** Asigna o actualiza (upsert) la ruta de un canton entero. */
  async upsertCanton(cantonCode: string, routeNumber: number) {
    const [row] = await db
      .insert(cantonRoutes)
      .values({ cantonCode, routeNumber })
      .onConflictDoUpdate({
        target: cantonRoutes.cantonCode,
        set: { routeNumber, updatedAt: new Date() },
      })
      .returning(cantonColumns);
    if (!row) throw new Error('No se pudo asignar la ruta del cantón.');
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

  /** Quita la asignacion de un canton. Devuelve null si no existia. */
  async removeCanton(cantonCode: string) {
    const [row] = await db
      .delete(cantonRoutes)
      .where(eq(cantonRoutes.cantonCode, cantonCode))
      .returning({ cantonCode: cantonRoutes.cantonCode });
    return row ?? null;
  },
};
