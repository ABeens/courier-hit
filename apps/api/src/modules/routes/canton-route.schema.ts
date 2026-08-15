/**
 * Tabla Drizzle de la ruta asignada a un CANTON entero (panel admin, permiso
 * routes.manage). Es el valor por defecto de todos los distritos del canton: no
 * escribe filas en `district_routes`, se resuelve al leer con un coalesce donde
 * la ruta propia del distrito manda (ver `effective-route.ts`).
 *
 * La clave primaria es el codigo oficial del canton (3 digitos): un canton tiene
 * a lo sumo una ruta. Varias filas pueden compartir route_number.
 */
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const cantonRoutes = pgTable('canton_routes', {
  cantonCode: text('canton_code').primaryKey(),
  routeNumber: integer('route_number').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CantonRouteRow = typeof cantonRoutes.$inferSelect;
export type NewCantonRouteRow = typeof cantonRoutes.$inferInsert;
