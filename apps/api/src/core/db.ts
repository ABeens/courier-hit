/**
 * Cliente Drizzle + pool de Postgres (docs/02-api.md §2, §7). Agrega el schema
 * de cada modulo para que drizzle-kit genere migraciones de todo el conjunto.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from './config';
import * as apiKeysSchema from '../modules/api-keys/api-keys.schema';
import * as authSchema from '../modules/auth/auth.schema';
import * as costServicesSchema from '../modules/cost-services/cost-service.schema';
import * as tariffsSchema from '../modules/tariffs/tariffs.schema';
import * as districtRoutesSchema from '../modules/routes/district-route.schema';
import * as cantonRoutesSchema from '../modules/routes/canton-route.schema';
import * as announcementsSchema from '../modules/announcements/announcement.schema';
import * as shipmentsSchema from '../modules/shipments/shipments.schema';
import * as shipmentCostsSchema from '../modules/costs/shipment-cost.schema';
import * as paymentsSchema from '../modules/payments/payments.schema';
import * as deliveriesSchema from '../modules/deliveries/deliveries.schema';
import * as settingsSchema from '../modules/settings/settings.schema';

/**
 * Pool que atiende las peticiones HTTP. El `max` es explicito: el default de
 * postgres.js son 10 conexiones, un techo bajo que no conviene heredar sin
 * saberlo (ver `DB_POOL_MAX` en `config.ts`).
 */
const client = postgres(config.DATABASE_URL, { max: config.DB_POOL_MAX });

/**
 * Pool APARTE, minusculo, solo para los advisory locks del robot (ver
 * `core/scheduler/with-lock.ts`).
 *
 * Va separado del pool principal porque una tarea en curso reserva una conexion
 * entera durante TODA su corrida (minutos, si el proveedor responde lento) sin
 * ejecutar nada en ella: solo sostiene el candado. Con las 4 tareas actuales
 * solapadas eso serian 4 conexiones apartadas del pool que atiende a los
 * usuarios. Aisladas aqui, el ritmo del robot no le quita turno a nadie.
 *
 * El trabajo de las tareas sigue usando `db`: este pool es solo para el candado.
 */
export const locksSql = postgres(config.DATABASE_URL, { max: config.DB_LOCK_POOL_MAX });

export const schema = {
  ...authSchema,
  ...apiKeysSchema,
  ...costServicesSchema,
  ...tariffsSchema,
  ...districtRoutesSchema,
  ...cantonRoutesSchema,
  ...shipmentsSchema,
  ...shipmentCostsSchema,
  ...paymentsSchema,
  ...deliveriesSchema,
  ...announcementsSchema,
  ...settingsSchema,
};
export const db = drizzle(client, { schema });
export type Db = typeof db;
