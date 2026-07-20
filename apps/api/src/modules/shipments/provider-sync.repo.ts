/**
 * Lecturas de la sincronizacion con el proveedor. Solo consulta: los cambios de
 * estado los escribe `shipmentsRepo.transition`, que es el punto unico.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { Flow, ShipmentType, flowForType } from '@courier/shared';
import { db } from '../../core/db';
import { clients } from '../auth/auth.schema';
import { shipments } from './shipments.schema';

/**
 * Solo Paqueteria se sincroniza: Transporte y Agenciamiento los mueve el
 * administrador a mano y el proveedor no sabe nada de ellos.
 */
const PACKAGE_TYPES = Object.values(ShipmentType).filter(
  (t) => flowForType(t) === Flow.Paqueteria,
) as [ShipmentType, ...ShipmentType[]];

export const providerSyncRepo = {
  /** Casilleros ya enlazados con el proveedor; los demas no tienen que consultar. */
  async linkedClients() {
    return db
      .select({
        id: clients.id,
        code: clients.code,
        helgaClientId: sql<string>`${clients.helgaClientId}`,
      })
      .from(clients)
      .where(isNotNull(clients.helgaClientId));
  },

  /**
   * Paquete de ese casillero con ese tracking. Se acota al casillero a proposito:
   * el proveedor responde por destinatario, y cruzar solo por tracking podria
   * pegarle el estado de un cliente al paquete de otro si dos reciclan la guia.
   */
  async findPackageByTracking(clientId: string, tracking: string) {
    const [row] = await db
      .select({
        id: shipments.id,
        code: shipments.code,
        state: shipments.state,
        shipmentType: shipments.shipmentType,
        tracking: shipments.tracking,
        description: shipments.description,
        weightKg: shipments.weightKg,
      })
      .from(shipments)
      .where(
        and(
          eq(shipments.clientId, clientId),
          eq(shipments.tracking, tracking),
          sql`${shipments.shipmentType} in ${PACKAGE_TYPES}`,
        ),
      )
      .limit(1);
    return row ?? null;
  },
};
