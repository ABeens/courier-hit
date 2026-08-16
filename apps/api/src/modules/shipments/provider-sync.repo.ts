/**
 * Lecturas de la sincronizacion con el proveedor. Solo consulta: los cambios de
 * estado los escribe `shipmentsRepo.transition`, que es el punto unico.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Flow, ShipmentType, State, flowForType } from '@courier/shared';
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
        lengthCm: shipments.lengthCm,
        widthCm: shipments.widthCm,
        heightCm: shipments.heightCm,
        volumetricWeightKg: shipments.volumetricWeightKg,
        // Sub-casillero del dueño: con el se comprueba que el paquete que devuelve
        // el proveedor es de este cliente y no de otro (`checkLockerMatch`).
        clientSubLocker: clients.helgaSubLocker,
      })
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .where(
        and(
          sql`${shipments.shipmentType} in ${PACKAGE_TYPES}`,
          inArray(shipments.state, PROVIDER_TRAMO_STATES),
        ),
      )
      .orderBy(asc(shipments.updatedAt))
      .limit(limit);
  },

  /**
   * De un lote de trackings, cuales YA tienen un tramite activo nuestro. Lo usa el
   * descubrimiento (flujo 2, docs/13 §3.3) para descartar de una sola consulta lo
   * que ya entro por el flujo 1.
   *
   * El criterio es "activo", el MISMO del indice unico parcial
   * `shipments_active_tracking`: ni entregado ni descartado. Cruzar contra el
   * historico completo seria un error por partida doble. Los transportistas
   * reciclan numeros de guia, asi que un tracking ya entregado puede pertenecer a
   * un paquete nuevo y legitimo; y un bulto descartado no reclama su guia, igual
   * que en `findActiveByHawb`. En los dos casos el indice unico deja pasar el alta
   * nueva, asi que darla por conocida aqui dejaria el paquete fuera del sistema
   * sin que nadie se entere.
   *
   * Los dos filtros tienen que estar los DOS para que el indice sirva: Postgres
   * solo usa un indice parcial cuando el WHERE de la consulta implica el predicado
   * del indice, y sin `discarded_at is null` no puede probarlo y barre la tabla.
   */
  async activeTrackings(trackings: string[]): Promise<Set<string>> {
    if (trackings.length === 0) return new Set();
    const rows = await db
      .select({ tracking: shipments.tracking })
      .from(shipments)
      .where(
        and(
          inArray(shipments.tracking, trackings),
          sql`${shipments.state} <> 'entregado'`,
          isNull(shipments.discardedAt),
        ),
      );
    return new Set(rows.map((r) => r.tracking));
  },
};
