/**
 * Lecturas que necesitan las automatizaciones de correo. Solo consulta: este
 * modulo no es dueño de ninguna tabla, se apoya en `shipments`, `clients` y
 * `users` para saber a quien escribirle.
 */
import { eq, inArray } from 'drizzle-orm';
import { Flow, ShipmentType, flowForType } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { shipments } from '../shipments/shipments.schema';

/**
 * Tipos cuyos tramites entran al resumen diario: los de Transporte y
 * Agenciamiento. Se DERIVAN del flow en vez de listarse a mano, para que agregar
 * un tipo nuevo no obligue a acordarse de este archivo.
 */
const SUMMARY_TYPES = Object.values(ShipmentType).filter(
  (t) => flowForType(t) !== Flow.Paqueteria,
) as [ShipmentType, ...ShipmentType[]];

export const notificationsRepo = {
  /** Dueño del tramite (nombre y correo), para el aviso de cambio de estado. */
  async ownerOf(shipmentId: string) {
    const [row] = await db
      .select({ name: users.name, email: users.email })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(eq(shipments.id, shipmentId))
      .limit(1);
    return row ?? null;
  },

  /**
   * Tramites de Transporte y Agenciamiento con su dueño. El filtro de "activo"
   * NO se hace aqui por estado: lo decide el trigger de cada step
   * (`DailyActiveSummary`), que el servicio consulta fila por fila. Asi la
   * definicion de "activo" vive solo en la maquina de estados.
   */
  async activeTransportShipments() {
    return db
      .select({
        code: shipments.code,
        shipmentType: shipments.shipmentType,
        state: shipments.state,
        description: shipments.description,
        name: users.name,
        email: users.email,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(inArray(shipments.shipmentType, SUMMARY_TYPES))
      .orderBy(users.email, shipments.code);
  },
};
