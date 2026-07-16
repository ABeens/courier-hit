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

const client = postgres(config.DATABASE_URL);

export const schema = { ...authSchema, ...costServicesSchema, ...tariffsSchema };
export const db = drizzle(client, { schema });
export type Db = typeof db;
