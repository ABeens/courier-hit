/**
 * Tabla Drizzle de la SERIE DE PROFORMAS (`proforma_numbers`).
 *
 * Es lo unico que el modulo de reportes persiste. El documento no se guarda (se
 * arma al pedirlo, ver `proforma.service.ts`); lo que se guarda es el numero que
 * se le asigno, porque un consecutivo que cambiara en cada impresion no seria un
 * consecutivo: el cliente llama citando "la proforma 1042" y esa tiene que
 * seguir siendo la suya.
 *
 * UNA SOLA SERIE para los dos documentos (proforma de tramite y proforma de cobro
 * consolidado): son el mismo documento del mismo negocio y llevar dos libros
 * obligaria a decir cual de los dos numeros es "el numero de proforma". Por eso
 * la fila tiene dos referencias opcionales y exactamente una llena, con CHECK: la
 * alternativa (dos tablas iguales) duplicaria la secuencia, el unico y la funcion
 * que las asigna.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  pgSequence,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { paymentGroups } from '../payments/payments.schema';
import { shipments } from '../shipments/shipments.schema';

/**
 * Secuencia del numero de proforma. Arranca en 1000 como las demas series del
 * negocio (`hs_shipment_code_seq`, `hs_client_code_seq`): la primera proforma es
 * la 1000 y ningun documento sale con un numero de un digito.
 */
export const proformaNumberSeq = pgSequence('hs_proforma_number_seq', {
  startWith: 1000,
  increment: 1,
});

export const proformaNumbers = pgTable(
  'proforma_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Valor crudo de la secuencia. Se guarda el NUMERO, no el texto que se
     * imprime: el formato (`formatProformaNumber`) vive en @courier/shared y es
     * el unico punto que lo escribe. Guardar el texto obligaria a migrar filas
     * el dia que el negocio quiera un ancho fijo o una serie por año.
     */
    sequence: integer('sequence').notNull().unique(),

    /**
     * El tramite al que se le emitio la proforma, o null si esta fila numera un
     * cobro consolidado. `cascade`: borrado el tramite, su numero no documenta
     * nada; la serie sigue su curso con un hueco, que es lo honesto.
     */
    shipmentId: uuid('shipment_id').references(() => shipments.id, { onDelete: 'cascade' }),
    /** El cobro agrupado al que se le emitio, o null si la fila numera un tramite. */
    paymentGroupId: uuid('payment_group_id').references(() => paymentGroups.id, {
      onDelete: 'cascade',
    }),

    /** Cuando se emitio el numero por primera vez. UTC. */
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * UN numero por tramite y UN numero por cobro. Es la regla que hace estable
     * al consecutivo: sin el unico, dos impresiones simultaneas del mismo
     * documento crearian dos filas y el cliente recibiria dos numeros para la
     * misma factura. Los unicos son PARCIALES porque la otra columna va nula en
     * cada caso, y en Postgres los nulos no compiten por un unico normal.
     */
    uniqueIndex('proforma_numbers_shipment_idx')
      .on(t.shipmentId)
      .where(sql`${t.shipmentId} is not null`),
    uniqueIndex('proforma_numbers_group_idx')
      .on(t.paymentGroupId)
      .where(sql`${t.paymentGroupId} is not null`),
    /*
     * Exactamente UNO de los dos dueños. Una fila con los dos numeraria dos
     * documentos con el mismo numero; una sin ninguno seria un numero emitido a
     * nadie, y ninguno de los dos casos tiene lectura posible mas adelante.
     */
    check(
      'proforma_numbers_one_owner',
      sql`(${t.shipmentId} is not null)::int + (${t.paymentGroupId} is not null)::int = 1`,
    ),
  ],
);

export type ProformaNumberRow = typeof proformaNumbers.$inferSelect;
