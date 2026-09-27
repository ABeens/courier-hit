/**
 * Parte del SEED DE DEMO (`seed-demo.ts`): el escenario del modulo de proformas
 * que recorre el guion del video (docs/demo-proformas.html).
 *
 * El resto del seed deja un tramite en cada estado, pero solo un borrador de
 * Paqueteria con un paquete: no alcanza para mostrar como se acumulan los
 * paquetes, como se mueve uno ni la entrega parcial. Esto agrega, recorridos por
 * la maquina de estados real (`transitionsService`):
 *
 *   - Laura Jimenez: 3 paquetes en "Facturación en proceso", juntos en UN
 *     borrador de proforma (con el flete ya calculado), y un cuarto paquete en
 *     "En Aduanas" que llega DESPUES de aprobar (va a un borrador nuevo).
 *   - Mario Solano: un tramite Aereo en "Facturación en proceso", con su
 *     proforma propia (Transporte no acumula) y sin costos cargados.
 *
 * Corre DESPUES de la transaccion principal y del backfill de proformas, porque
 * usa los servicios de la API (que abren sus propias transacciones). Son tramites
 * de clientes de demo, asi que `--reset` los borra con el resto.
 */
import { eq } from 'drizzle-orm';
import { Flow, Principal, Role, ShipmentType, State, formatShipmentCode } from '@courier/shared';
import type { Session } from '@courier/shared';
import { db } from './core/db';
import { clients, users } from './modules/auth/auth.schema';
import { shipmentsRepo } from './modules/shipments/shipments.repo';
import { transitionsService } from './modules/shipments/transitions.service';
import { pathTo } from './seed-support';

async function clientByHandle(domain: string, handle: string) {
  const [row] = await db
    .select({ clientId: clients.id, name: users.name })
    .from(users)
    .innerJoin(clients, eq(clients.userId, users.id))
    .where(eq(users.email, `${handle}@${domain}`));
  if (!row) throw new Error(`[seed-demo] Falta el cliente de demo ${handle}.`);
  return row;
}

/** Siembra el escenario e imprime los codigos que usa el guion. */
export async function seedProformaScenario(domain: string): Promise<void> {
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.email, `jose.alfaro@${domain}`));
  if (!admin) throw new Error('[seed-demo] Falta el administrador de demo.');
  const session: Session = { sessionId: 'seed-demo', userId: admin.id, principal: Principal.Staff, role: Role.Admin };

  let n = 0;
  /** Crea el tramite en Prealertado y lo avanza paso a paso hasta `to`. */
  const create = async (spec: {
    clientId: string;
    type: ShipmentType;
    flow: Flow;
    to: State;
    description: string;
    weightKg: number;
    hawb?: string;
    store?: string;
  }): Promise<string> => {
    n++;
    const code = formatShipmentCode(await shipmentsRepo.nextCodeSequence());
    const id = await shipmentsRepo.insert({
      code,
      clientId: spec.clientId,
      shipmentType: spec.type,
      state: State.Prealertado,
      tracking: `DEMO-PF-${String(n).padStart(3, '0')}`,
      description: spec.description,
      weightKg: spec.weightKg,
      hawb: spec.hawb ?? null,
      store: spec.store ?? null,
      createdBy: admin.id,
    });
    for (const state of pathTo(spec.flow, spec.to).slice(1)) {
      await transitionsService.transition(session, id, { state }, { skipPermission: true });
    }
    return code;
  };

  const laura = await clientByHandle(domain, 'laura.jimenez');
  const mario = await clientByHandle(domain, 'mario.solano');
  const pkg = { clientId: laura.clientId, type: ShipmentType.Paqueteria, flow: Flow.Paqueteria };

  const a1 = await create({ ...pkg, to: State.FacturacionEnProceso, description: 'Audífonos inalámbricos', weightKg: 0.8, hawb: 'LES900001', store: 'Amazon' });
  const a2 = await create({ ...pkg, to: State.FacturacionEnProceso, description: 'Zapatos deportivos', weightKg: 1.6, hawb: 'LES900002', store: 'Nike' });
  const a3 = await create({ ...pkg, to: State.FacturacionEnProceso, description: 'Cafetera eléctrica', weightKg: 3.2, hawb: 'LES900003', store: 'Walmart' });
  const a4 = await create({ ...pkg, to: State.EnAduanas, description: 'Lámpara de escritorio', weightKg: 1.1, hawb: 'LES900004', store: 'IKEA' });
  const t1 = await create({
    clientId: mario.clientId, type: ShipmentType.Aereo, flow: Flow.Transporte, to: State.FacturacionEnProceso,
    description: 'Repuestos de maquinaria', weightKg: 45,
  });

  console.log('\n[seed-demo] Escenario del video de proformas (docs/demo-proformas.html):');
  console.log(`  A1, A2, A3  ${a1}, ${a2}, ${a3}  (${laura.name}, juntos en un borrador)`);
  console.log(`  A4          ${a4}  (${laura.name}, En Aduanas)`);
  console.log(`  T1          ${t1}  (${mario.name}, Aéreo en Facturación en proceso)`);
  console.log('');
}
