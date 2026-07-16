/**
 * Tabla Drizzle de la definicion de rutas (panel admin, permiso routes.manage).
 * Guarda SOLO la asignacion distrito -> numero de ruta; el catalogo territorial
 * (provincias/cantones/distritos) es estatico y vive en @courier/shared.
 *
 * La clave primaria es el codigo oficial del distrito (5 digitos): un distrito
 * tiene a lo sumo una ruta. Varias filas pueden compartir route_number (una ruta
 * cubre varios distritos).
 */
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const districtRoutes = pgTable('district_routes', {
  districtCode: text('district_code').primaryKey(),
  routeNumber: integer('route_number').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type DistrictRouteRow = typeof districtRoutes.$inferSelect;
export type NewDistrictRouteRow = typeof districtRoutes.$inferInsert;
