/**
 * Diagnostico de "no llego el correo de avance de estado".
 *
 * Uso: pnpm --filter @courier/api db:diagnose-mail <codigo-de-tramite | correo>
 *
 * Reconstruye, para cada evento del historial, si ese paso DEBIA disparar correo
 * segun la maquina de estados y si habia a quien enviarselo. No manda nada.
 */
import { asc, eq, or } from 'drizzle-orm';
import { Flow, STATE_LABELS, Trigger, flowForType, triggersOnEnter } from '@courier/shared';
import type { ShipmentType, State } from '@courier/shared';
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

  if (flow !== Flow.Paqueteria) {
    console.log('');
    console.log('>> Este flujo NO tiene aviso inmediato: solo entra al resumen diario,');
    console.log('   que hoy no esta programado. Por eso no llego ningun correo.');
  }

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
  console.log('Historial (UTC)                 estado                          ¿debia enviar correo?');
  for (const e of events) {
    const notifies = triggersOnEnter(flow, e.state as State).includes(Trigger.NotifyStateChange);
    // `correct()` escribe el evento con este prefijo y NO dispara las
    // automatizaciones: es la unica forma de llegar a un estado notificable sin
    // que salga el correo.
    const corrected = e.note?.startsWith('Corrección:') ?? false;
    const verdict = !notifies
      ? 'no (el estado no notifica)'
      : corrected
        ? '*** no (corrección de admin: no notifica por diseño) ***'
        : s.clientId
          ? 'SI -> buscar "[mailer]" en el log a esa hora'
          : '*** no (sin dueño a quien escribirle) ***';
    const who = corrected ? 'corrección' : e.createdBy ? 'panel' : 'robot';
    console.log(
      `${e.createdAt.toISOString()}  ${STATE_LABELS[e.state as State].padEnd(30)}  ${verdict}  (${who})`,
    );
  }
}

process.exit(0);
