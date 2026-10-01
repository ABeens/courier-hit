/**
 * TIPO de la tarifa efectiva de un casillero, como expresion SQL para las
 * consultas de lectura: la tarifa asignada o, si quedo sin ninguna, la por
 * defecto. Es la misma regla que `clientsRepo.rateFor`, pero sin una consulta
 * por fila, para que los listados puedan mostrar el peso FACTURABLE
 * (`displayedWeightKg`) de cada tramite.
 *
 * Subconsultas y no JOINs: el seguimiento de joins de Drizzle deja de inferir la
 * fila a partir del cuarto join (ver `reports.repo`), y el listado de tramites ya
 * los tiene todos ocupados.
 *
 * Null cuando el tramite no tiene casillero (paquete sin dueño en la sala de
 * control): sin casillero no hay tarifa ni cobro.
 */
import { eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { ClientRateKind } from '@courier/shared';
import { clients } from '../auth/auth.schema';
import { clientRates } from './tariffs.schema';

export function effectiveRateKind(clientId: AnyPgColumn) {
  const assigned = sql`(select ${clientRates.kind} from ${clients}
    inner join ${clientRates} on ${eq(clients.clientRateId, clientRates.id)}
    where ${clients.id} = ${clientId})`;
  const fallback = sql`(select ${clientRates.kind} from ${clientRates} where ${clientRates.isDefault} limit 1)`;
  return sql<ClientRateKind | null>`case when ${clientId} is null then null else coalesce(${assigned}, ${fallback}) end`;
}
