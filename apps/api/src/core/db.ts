/**
 * Cliente Drizzle + pool de Postgres (docs/02-api.md §2, §7). Agrega el schema
 * de cada modulo para que drizzle-kit genere migraciones de todo el conjunto.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from './config';
import * as authSchema from '../modules/auth/auth.schema';
import * as costServicesSchema from '../modules/cost-services/cost-service.schema';
import * as tariffsSchema from '../modules/tariffs/tariffs.schema';
import * as routesSchema from '../modules/routes/district-route.schema';
import * as announcementsSchema from '../modules/announcements/announcement.schema';
import * as shipmentsSchema from '../modules/shipments/shipments.schema';

const client = postgres(config.DATABASE_URL);

export const schema = {
  ...authSchema,
  ...costServicesSchema,
  ...tariffsSchema,
  ...routesSchema,
  ...shipmentsSchema,
  ...announcementsSchema,
};
export const db = drizzle(client, { schema });
export type Db = typeof db;
