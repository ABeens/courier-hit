/**
 * Acceso a datos de los casilleros (perfil de cliente). Lee de `clients` + `users`
 * (identidad) + `client_rates` (tarifa asignada) + `shipments` (conteo de tramites).
 *
 * Las tablas `clients`/`users` las declara el modulo auth: este modulo las lee
 * pero no las modifica; su dueño sigue siendo auth.
 */
import { and, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../core/db';
import { clients, users } from '../auth/auth.schema';
import { shipments } from '../shipments/shipments.schema';
import { clientRates } from '../tariffs/tariffs.schema';

const columns = {
  id: clients.id,
  code: clients.code,
  name: users.name,
  email: users.email,
  phone: users.phone,
  idNumber: clients.idNumber,
  provinceCode: clients.provinceCode,
  cantonCode: clients.cantonCode,
  districtCode: clients.districtCode,
  addressLine: clients.addressLine,
  reviewStatus: clients.reviewStatus,
  clientRateName: clientRates.name,
  clientRateId: clients.clientRateId,
  creditLimit: clients.creditLimit,
  creditLimitCurrency: clients.creditLimitCurrency,
  /** Sub-casillero que asigna el proveedor; es la direccion real en Miami. */
  helgaSubLocker: clients.helgaSubLocker,
  createdAt: clients.createdAt,
};

function baseQuery() {
  return db
    .select({
      ...columns,
      /**
       * Conteo de tramites del casillero. Va como subconsulta correlacionada y no
       * como JOIN + GROUP BY para no tener que agrupar por todas las columnas de
       * arriba (y para que el conteo no se rompa si luego se añaden mas joins).
       */
      shipmentCount: sql<number>`(
        select count(*)::int from ${shipments} where ${shipments.clientId} = ${clients.id}
      )`,
    })
    .from(clients)
    .innerJoin(users, eq(clients.userId, users.id))
    .leftJoin(clientRates, eq(clients.clientRateId, clientRates.id));
}

export const clientsRepo = {
  /** Listado del dashboard de casilleros; `q` busca por nombre, codigo, cedula o correo. */
  async list(q?: string) {
    const conds: SQL[] = [];
    if (q) {
      const term = `%${q}%`;
      const match = or(
        ilike(users.name, term),
        ilike(clients.code, term),
        ilike(clients.idNumber, term),
        ilike(users.email, term),
      );
      if (match) conds.push(match);
    }
    const query = baseQuery().orderBy(users.name);
    return conds.length > 0 ? query.where(and(...conds)) : query;
  },

  async findById(id: string) {
    const [row] = await baseQuery().where(eq(clients.id, id)).limit(1);
    return row ?? null;
  },

  /**
   * Actualiza el perfil del casillero. `clients` la declara el modulo auth, pero
   * la edicion comercial (tarifa, limite de credito, flag de revision) es
   * responsabilidad de este modulo: es quien la expone al panel.
   */
  async update(id: string, patch: Partial<typeof clients.$inferInsert>) {
    await db.update(clients).set(patch).where(eq(clients.id, id));
  },

  /** Enlace del casillero con el proveedor; null si aun no se registro alli. */
  async providerLinkFor(clientId: string) {
    const [row] = await db
      .select({ helgaClientId: clients.helgaClientId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    return row ?? null;
  },

  /**
   * Indice INVERSO del enlace: dado un lote de `destinatario_id` de Helga,
   * devuelve a que casillero nuestro corresponde cada uno.
   *
   * Lo usa el descubrimiento de paquetes (flujo 2, docs/13 §3.3): la op. E lista
   * los paquetes de toda la cuenta consolidada y cada fila trae su
   * `destinatario_id`, asi que hay que ir de Helga hacia nosotros y no al reves.
   *
   * Es una sola consulta por lote a proposito: preguntar por cada fila seria N+1
   * contra la BD por cada corrida del robot. `helga_client_id` es UNIQUE, asi que
   * el indice ya existe y no hace falta agregar ninguno.
   */
  async findByHelgaClientIds(helgaClientIds: string[]) {
    if (helgaClientIds.length === 0) return [];
    return db
      .select({ id: clients.id, code: clients.code, helgaClientId: clients.helgaClientId })
      .from(clients)
      .where(inArray(clients.helgaClientId, helgaClientIds));
  },

  async count() {
    const [row] = await db.select({ n: count() }).from(clients);
    return row?.n ?? 0;
  },

  /**
   * Tarifa EFECTIVA del casillero: la asignada o, si quedo sin ninguna (el FK
   * queda en null al borrar una tarifa), la tarifa por defecto del sistema.
   *
   * Punto unico de resolucion: de aqui salen tanto el precio por kg del flete
   * como los medios de pago admitidos, asi un casillero nunca se queda sin
   * tarifa a efectos de facturacion. Null solo si el casillero no existe o si
   * el sistema se quedo sin tarifa por defecto (estado invalido, lo impide el
   * modulo de tarifas).
   */
  async rateFor(clientId: string) {
    const rateColumns = {
      rateId: clientRates.id,
      rateName: clientRates.name,
      pricePerKg: clientRates.pricePerKg,
      currency: clientRates.currency,
      allowsCard: clientRates.allowsCard,
      allowsBankDeposit: clientRates.allowsBankDeposit,
    };

    const [assigned] = await db
      .select(rateColumns)
      .from(clients)
      .innerJoin(clientRates, eq(clients.clientRateId, clientRates.id))
      .where(eq(clients.id, clientId))
      .limit(1);
    if (assigned) return { ...assigned, isFallback: false };

    // Sin tarifa asignada: se factura con la por defecto, pero se avisa (isFallback)
    // para que la UI lo muestre en vez de hacerlo pasar por una eleccion comercial.
    const [exists] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!exists) return null;

    const [fallback] = await db
      .select(rateColumns)
      .from(clientRates)
      .where(eq(clientRates.isDefault, true))
      .limit(1);
    return fallback ? { ...fallback, isFallback: true } : null;
  },

  /**
   * Medios de pago que admite la tarifa del casillero. El manual los trata como
   * una propiedad de la TARIFA, no del cliente ("Si el cliente esta asociado a
   * una tarifa que no permite pago por tarjeta de credito no debe mostrar esa
   * opcion"), asi que se leen de ahi (con el mismo fallback que `rateFor`).
   */
  async paymentOptionsFor(clientId: string) {
    const rate = await this.rateFor(clientId);
    if (!rate) return null;
    return { allowsCard: rate.allowsCard, allowsBankDeposit: rate.allowsBankDeposit };
  },
};
