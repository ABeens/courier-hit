/**
 * Diagnostico de "no me aparecio el cambio en el correo".
 *
 * Uso: pnpm --filter @courier/api db:diagnose-mail <codigo-de-tramite | correo>
 *
 * No hay avisos inmediatos: el cliente recibe CORREOS DIARIOS con el estado
 * ACTUAL de sus tramites y paquetes (notifications.service.ts). Este script dice
 * si el tramite sale en el correo de mañana, en cual y por que, y muestra su
 * historial para entender como llego a su estado. No manda nada.
 */
import { asc, eq, or } from 'drizzle-orm';
import { Flow, STATE_LABELS, State, Trigger, flowForType, triggersOnEnter } from '@courier/shared';
import type { ShipmentType } from '@courier/shared';
import { db } from './core/db';
import { clients, users } from './modules/auth/auth.schema';
import { shipmentEvents, shipments } from './modules/shipments/shipments.schema';

const arg = process.argv[2];
if (!arg) {
  console.error('Falta el argumento: codigo de tramite (HS-1234) o correo del cliente.');
  process.exit(1);
}

const rows = await db
  .select({
    id: shipments.id,
    code: shipments.code,
    tracking: shipments.tracking,
    shipmentType: shipments.shipmentType,
    state: shipments.state,
    clientId: shipments.clientId,
    discardedAt: shipments.discardedAt,
    ownerName: users.name,
    ownerEmail: users.email,
  })
  .from(shipments)
  .leftJoin(clients, eq(shipments.clientId, clients.id))
  .leftJoin(users, eq(clients.userId, users.id))
  .where(or(eq(shipments.code, arg), eq(shipments.tracking, arg), eq(users.email, arg)));

if (rows.length === 0) {
  console.log(`No hay ningun tramite con codigo/tracking/dueño "${arg}".`);
  process.exit(0);
}

for (const s of rows) {
  const flow = flowForType(s.shipmentType as ShipmentType);
  console.log('');
  console.log(`=== ${s.code} (${s.tracking}) ===`);
  console.log(`Tipo:   ${s.shipmentType}  ->  flujo ${flow}`);
  console.log(`Estado: ${STATE_LABELS[s.state as State]}`);
  console.log(`Dueño:  ${s.clientId ? `${s.ownerName} <${s.ownerEmail}>` : '*** SIN DUEÑO (clientId null) ***'}`);
  if (s.discardedAt) console.log(`Descartado: ${s.discardedAt.toISOString()}`);


  const events = await db
    .select({
      state: shipmentEvents.state,
      note: shipmentEvents.note,
      createdAt: shipmentEvents.createdAt,
      createdBy: shipmentEvents.createdBy,
    })
    .from(shipmentEvents)
    .where(eq(shipmentEvents.shipmentId, s.id))
    .orderBy(asc(shipmentEvents.createdAt));

  console.log('');
  console.log(`Correo diario: ${verdict(s, flow)}`);
  console.log('');
  console.log('Historial (UTC)                 estado');
  for (const e of events) {
    const corrected = e.note?.startsWith('Corrección:') ?? false;
    const who = corrected ? 'corrección' : e.createdBy ? 'panel' : 'robot';
    console.log(`${e.createdAt.toISOString()}  ${STATE_LABELS[e.state as State].padEnd(30)}  (${who})`);
  }
}

/** Si el tramite sale en el correo diario de mañana, segun su estado ACTUAL. */
function verdict(s: (typeof rows)[number], flow: Flow): string {
  if (!s.clientId) return '*** no (sin dueño a quien escribirle) ***';
  if (s.discardedAt) return 'no (descartado)';
  const triggers = triggersOnEnter(flow, s.state as State);
  if (flow !== Flow.Paqueteria) {
    return triggers.includes(Trigger.DailyActiveSummary)
      ? 'SI, en "Reporte de estatus trámites HS GLOBAL" (buscar "[digest]" en el log)'
      : 'no (el trámite ya no está en curso)';
  }
  if (s.state === State.Entregado) return 'no (ya entregado)';
  return triggers.includes(Trigger.DailyPackageReport)
    ? 'SI, en "Reporte de estatus paquetes HS GLOBAL": su estado hace que el correo salga'
    : 'solo si el cliente tiene otro paquete en Recibido en Miami, En Aduanas o En ruta de entrega (ahí va listado)';
}

process.exit(0);
