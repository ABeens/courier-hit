/**
 * Acceso a datos del modulo de entregas. Dueño de `delivery_attempts`; lee
 * `shipments` + `clients` + `users` + `district_routes` para armar la cola del
 * mensajero (que necesita saber a nombre de quien va y por que ruta).
 */
import { and, asc, eq, ilike, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { State } from '@courier/shared';
import type { ListDeliveryQueueQuery } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { districtRoutes } from '../routes/district-route.schema';
import { shipments } from '../shipments/shipments.schema';
import { deliveryAttempts } from './deliveries.schema';

export const deliveriesRepo = {
  /**
   * Cola del mensajero: los tramites "En ruta de entrega". El estado NO es un
   * filtro opcional, es la definicion de la cola (Parte 5: "todos los paquetes
   * que se encuentren en el estado Ruta de Entrega"), asi que va fijo y no se
   * puede aflojar desde la query.
   */
  async queue(query: ListDeliveryQueueQuery) {
    const conds: SQL[] = [eq(shipments.state, State.EnRutaEntrega)];

    if (query.routeNumber !== undefined) {
      conds.push(eq(districtRoutes.routeNumber, query.routeNumber));
    }
    if (query.q) {
      const term = `%${query.q}%`;
      const match = or(
        ilike(users.name, term),
        ilike(shipments.tracking, term),
        ilike(shipments.code, term),
      );
      if (match) conds.push(match);
    }

    return db
      .select({
        id: shipments.id,
        code: shipments.code,
        tracking: shipments.tracking,
        description: shipments.description,
        shipmentType: shipments.shipmentType,
        clientName: users.name,
        clientPhone: users.phone,
        provinceCode: clients.provinceCode,
        cantonCode: clients.cantonCode,
        districtCode: clients.districtCode,
        addressLine: clients.addressLine,
        routeNumber: districtRoutes.routeNumber,
        invoiceTotalCrc: shipments.invoiceTotalCrc,
        updatedAt: shipments.updatedAt,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .leftJoin(districtRoutes, eq(clients.districtCode, districtRoutes.districtCode))
      .where(and(...conds))
      // Por ruta y luego por antiguedad: es el orden en que se arma un recorrido.
      .orderBy(asc(districtRoutes.routeNumber), asc(shipments.updatedAt));
  },

  /** Intentos de un tramite, del mas antiguo al mas reciente. */
  async listByShipment(shipmentId: string) {
    return db
      .select({
        id: deliveryAttempts.id,
        shipmentId: deliveryAttempts.shipmentId,
        outcome: deliveryAttempts.outcome,
        photoFileKey: deliveryAttempts.photoFileKey,
        note: deliveryAttempts.note,
        createdAt: deliveryAttempts.createdAt,
        courierName: users.name,
      })
      .from(deliveryAttempts)
      .leftJoin(users, eq(deliveryAttempts.courierId, users.id))
      .where(eq(deliveryAttempts.shipmentId, shipmentId))
      .orderBy(asc(deliveryAttempts.createdAt));
  },

  async findById(id: string) {
    const [row] = await db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.id, id))
      .limit(1);
    return row ?? null;
  },

  async insert(values: typeof deliveryAttempts.$inferInsert) {
    const [row] = await db
      .insert(deliveryAttempts)
      .values(values)
      .returning({ id: deliveryAttempts.id });
    if (!row) throw new Error('No se pudo registrar el intento de entrega.');
    return row.id;
  },
};
