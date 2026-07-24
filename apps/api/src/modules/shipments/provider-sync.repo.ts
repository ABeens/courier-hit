/**
 * Lecturas de la sincronizacion con el proveedor. Solo consulta: los cambios de
 * estado los escribe `shipmentsRepo.transition`, que es el punto unico.
 */
import { and, asc, inArray, sql } from 'drizzle-orm';
import { Flow, ShipmentType, State, flowForType } from '@courier/shared';
import { db } from '../../core/db';
import { shipments } from './shipments.schema';

/**
 * Solo Paqueteria se sincroniza: Transporte y Agenciamiento los mueve el
 * administrador a mano y el proveedor no sabe nada de ellos.
 */
const PACKAGE_TYPES = Object.values(ShipmentType).filter(
  (t) => flowForType(t) === Flow.Paqueteria,
) as [ShipmentType, ...ShipmentType[]];

/**
 * Estados del tramo del proveedor que todavia vale la pena consultar. `EnAduanas`
 * es el ULTIMO estado del proveedor (docs/13 §3.4): al alcanzarlo, el tramite
 * pasa al flujo manual de HS Global y ya no hay nada que sincronizar, asi que no
 * se incluye. Un envio en `Prealertado` si se consulta: op. B devuelve 404 hasta
 * que el paquete llega a bodega, y es justo esa consulta la que detecta la llegada.
 */
const PROVIDER_TRAMO_STATES = [
  State.Prealertado,
  State.RecibidoBodegaMiami,
  State.PreparandoEnvio,
  State.EnTransitoCostaRica,
] as [State, ...State[]];

export const providerSyncRepo = {
  /**
   * Nuestros envios de Paqueteria que siguen dentro del tramo del proveedor. La
   * sincronizacion parte de AQUI (no de Helga): la op. B consulta un paquete por
   * su tracking, asi que se recorre lo que tenemos y se le pregunta a Helga por
   * cada uno. Se ordena por el mas rezagado (`updatedAt` ascendente) y se acota
   * con `limit` para acotar cada corrida.
   */
  async shipmentsInProviderTramo(limit: number) {
    return db
      .select({
        id: shipments.id,
        code: shipments.code,
        clientId: shipments.clientId,
        state: shipments.state,
        shipmentType: shipments.shipmentType,
        tracking: shipments.tracking,
        description: shipments.description,
        weightKg: shipments.weightKg,
      })
      .from(shipments)
      .where(
        and(
          sql`${shipments.shipmentType} in ${PACKAGE_TYPES}`,
          inArray(shipments.state, PROVIDER_TRAMO_STATES),
        ),
      )
      .orderBy(asc(shipments.updatedAt))
      .limit(limit);
  },
};
