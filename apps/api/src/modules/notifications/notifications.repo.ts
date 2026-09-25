/**
 * Lecturas que necesitan los CORREOS DIARIOS al cliente. Solo consulta: este
 * modulo no es dueño de ninguna tabla, se apoya en los tramites y en las cuentas
 * de los clientes para saber que contar y a quien.
 */
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { Flow, ShipmentType, State, flowForType } from '@courier/shared';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { shipments } from '../shipments/shipments.schema';

/**
 * Tipos de cada correo, DERIVADOS del flow para que agregar un tipo nuevo no
 * obligue a acordarse de este archivo: Paqueteria va en el de paquetes, el resto
 * (Transporte y Agenciamiento) en el de tramites.
 */
const PACKAGE_TYPES = Object.values(ShipmentType).filter(
  (t) => flowForType(t) === Flow.Paqueteria,
) as [ShipmentType, ...ShipmentType[]];
const TRAMITE_TYPES = Object.values(ShipmentType).filter(
  (t) => flowForType(t) !== Flow.Paqueteria,
) as [ShipmentType, ...ShipmentType[]];

/** Columnas comunes: el tramite y a quien se le escribe. */
const columns = {
  code: shipments.code,
  shipmentType: shipments.shipmentType,
  state: shipments.state,
  description: shipments.description,
  hawb: shipments.hawb,
  tracking: shipments.tracking,
  clientId: clients.id,
  name: users.name,
  email: users.email,
};

export const notificationsRepo = {
  /**
   * Tramites de Transporte y Agenciamiento con su dueño. El filtro de "en curso"
   * NO se hace aqui por estado: lo decide el trigger de cada step
   * (`DailyActiveSummary`), que el servicio consulta fila por fila.
   */
  async tramites() {
    return db
      .select(columns)
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(and(inArray(shipments.shipmentType, TRAMITE_TYPES), isNull(shipments.discardedAt)))
      .orderBy(asc(users.email), asc(shipments.code));
  },

  /**
   * Paquetes EN PROCESO (todo lo que no se ha entregado) con su dueño. A quien
   * se le escribe lo decide el servicio con el trigger `DailyPackageReport`; aqui
   * se traen todos porque el correo lista todos los paquetes en proceso del
   * cliente, no solo los que estan en un estado que avisa.
   */
  async packagesInProcess() {
    return db
      .select(columns)
      .from(shipments)
      .innerJoin(clients, eq(shipments.clientId, clients.id))
      .innerJoin(users, eq(clients.userId, users.id))
      .where(
        and(
          inArray(shipments.shipmentType, PACKAGE_TYPES),
          ne(shipments.state, State.Entregado),
          isNull(shipments.discardedAt),
        ),
      )
      .orderBy(asc(users.email), asc(shipments.code));
  },
};
