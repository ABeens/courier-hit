/**
 * Lectura del estado de COBRO de un tramite para quien no es el modulo de pagos.
 *
 * El listado de tramites y la cola del mensajero tienen que decir si un paquete
 * ya se cobro, y ninguno de los dos puede pedirle los pagos a la API de pagos por
 * fila: seria una consulta por tramite. Esto resuelve el mismo dato como una
 * subconsulta correlacionada que viaja pegada al SELECT que ya se estaba
 * haciendo, sin viaje extra a la base.
 *
 * DECISION CLAVE: la subconsulta NO suma. Devuelve los abonos crudos (monto,
 * moneda, tasa y situacion) y la suma la sigue haciendo `settledAmount` de
 * @courier/shared en TypeScript.
 *
 * Es a proposito y es lo importante de este archivo. Escribir el
 * `sum(case when currency = 'USD' then amount * exchange_rate ...)` en SQL era
 * mas corto, pero duplicaba en el dialecto de Postgres tres reglas de dinero que
 * viven en un solo lugar: la conversion con la tasa de CADA pago (M5), el
 * redondeo por moneda (M4) y el filtro de "solo cuenta lo confirmado". El dia que
 * una de esas reglas cambie, el SQL no se entera y el reporte y la bandera
 * empiezan a discrepar por unos colones que nadie sabe explicar.
 */
import { sql } from 'drizzle-orm';
import type { Currency, PaymentStatus } from '@courier/shared';
import { shipments } from '../shipments/shipments.schema';
import { payments } from './payments.schema';

/** Abono crudo tal como lo devuelve la subconsulta; lo que `settledAmount` pide. */
export interface SettleablePayment {
  amount: number;
  currency: Currency;
  exchangeRate: number;
  status: PaymentStatus;
}

/** Alias de `payments` dentro de la subconsulta. Ver la nota de calificacion abajo. */
const ALIAS = 'stl';

/**
 * `stl.<columna>` tomado del esquema, no escrito a mano: si alguien renombra la
 * columna en `payments.schema.ts`, esto se mueve con ella.
 */
function aliased(column: { name: string }) {
  return sql.raw(`${ALIAS}.${column.name}`);
}

/**
 * Columna de SELECT con los pagos del tramite de la fila, como arreglo JSON.
 *
 * Se traen TODOS, no solo los confirmados: el filtro por situacion ya lo aplica
 * `settledAmount`, y repetirlo aqui seria la misma regla escrita dos veces. El
 * `coalesce` deja `[]` en vez de `null` para que quien la lea no tenga que
 * defenderse de un nulo.
 *
 * Solo sirve en consultas que tengan `shipments` en el FROM: la correlacion es
 * contra `shipments.id`.
 *
 * POR QUE EL ALIAS Y LOS NOMBRES EXPLICITOS. Interpolar las columnas de Drizzle
 * (`${payments.amount}`) parecia lo natural, pero Drizzle decide si califica con
 * el nombre de la tabla segun la consulta que las envuelve: con joins emite
 * `"payments"."shipment_id"`, y sin joins emite `"shipment_id"` a secas. Sin
 * calificar, la correlacion `where shipment_id = id` se resuelve DENTRO de la
 * subconsulta —`payments` tambien tiene una columna `id`— y compara el pago con
 * su propio identificador: nunca casa, la lista sale vacia y todos los tramites
 * se ven como no pagados. Un fallo mudo, y del peor lado: dice "sin cobrar" de
 * algo ya cobrado. Con el alias propio y `"shipments".id` explicito, la
 * subconsulta significa lo mismo en cualquier consulta que la use.
 */
export const settlementColumn = sql<SettleablePayment[]>`coalesce((
  select json_agg(json_build_object(
    'amount', ${aliased(payments.amount)},
    'currency', ${aliased(payments.currency)},
    'exchangeRate', ${aliased(payments.exchangeRate)},
    'status', ${aliased(payments.status)}
  ))
  from ${payments} ${sql.raw(ALIAS)}
  where ${aliased(payments.shipmentId)} = ${shipments}.${sql.raw(shipments.id.name)}
), '[]'::json)`;
