/**
 * Tablas Drizzle del modulo de proformas (docs/proformas-cambios.html, area 1).
 *
 * La proforma deja de ser un documento que se arma al pedirlo y pasa a ser un
 * registro: el grupo de tramites de un cliente que se revisa, se aprueba, se
 * cobra y se entrega como una unidad. Cuatro tablas:
 *
 *   - `proformas`: la cabecera (cliente, flujo, moneda, estado, numero, totales).
 *   - `proforma_shipments`: que tramites agrupa. Un tramite esta en UNA sola
 *     proforma a la vez, y lo garantiza la clave primaria, no el servicio.
 *   - `proforma_costs`: los servicios adicionales cargados a la proforma entera
 *     (no a un paquete). El flete de cada paquete y los costos propios de cada
 *     tramite siguen en `shipment_costs`: son de ese tramite, y es ahi donde los
 *     leen los reportes por tramite.
 *   - `proforma_counter`: el contador del numero de proforma (una sola fila).
 *
 * El estado y las reglas de quien entra a que proforma salen de @courier/shared
 * (`proformas/proforma.ts`): aqui solo se persisten.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  DEFAULT_COST_CATEGORY,
  FLOW_VALUES,
  PROFORMA_STATUS_VALUES,
  ProformaStatus,
} from '@courier/shared';
import { currencyEnum } from '../../core/currency.schema';
import { clients, users } from '../auth/auth.schema';
import { costCategoryEnum, costServices } from '../cost-services/cost-service.schema';
import { costLineSourceEnum } from '../costs/shipment-cost.schema';
import { payments } from '../payments/payments.schema';
import { shipments } from '../shipments/shipments.schema';

export const proformaStatusEnum = pgEnum('proforma_status', PROFORMA_STATUS_VALUES);

/**
 * Flujo de la proforma. Es la primera tabla que guarda un flow: el tramite no lo
 * hace porque lo deriva de su tipo (`flowForType`). La proforma no tiene tipo
 * propio y puede juntar varios (aereo con maritimo), asi que lo que la define es
 * el flujo, y hay que guardarlo.
 */
export const shipmentFlowEnum = pgEnum('shipment_flow', FLOW_VALUES);

export const proformas = pgTable(
  'proformas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Cascada, como los cobros del casillero (`payment_groups`): las proformas son
     * del cliente, y borrar un casillero (solo pasa en limpiezas de datos de
     * prueba) no puede quedar trabado por ellas.
     */
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    flow: shipmentFlowEnum('flow').notNull(),
    /**
     * Moneda de la proforma: la de cobro de su flujo (`proformaCurrencyFor`).
     * Explicita (regla M2) aunque hoy se deduzca del flujo: es la columna contra
     * la que se compara lo pagado.
     */
    currency: currencyEnum('currency').notNull(),
    status: proformaStatusEnum('status').notNull().default(ProformaStatus.Borrador),
    /**
     * EL BORRADOR QUE ACUMULA. Solo Paqueteria arma sus borradores sola, y los
     * paquetes que llegan tienen que caer en UNO concreto del cliente: este. Los
     * demas borradores del mismo cliente (los que el operador crea al separar
     * paquetes, o uno que volvio a borrador por una correccion) no reciben nada
     * solos. El indice unico parcial de abajo garantiza que haya a lo sumo uno.
     */
    accumulates: boolean('accumulates').notNull().default(false),
    /**
     * Numero de proforma. Null en un borrador que nunca se aprobo; se asigna al
     * aprobar (`proforma_counter`) y NO se borra si la proforma vuelve a
     * borrador por una correccion: al reaprobar sale con el mismo.
     */
    number: integer('number'),
    /**
     * Tasa congelada al aprobar (colones por 1 USD, regla M5): la del total en la
     * otra moneda. Cada linea conserva ademas la suya.
     */
    exchangeRate: doublePrecision('exchange_rate'),
    /** Total aprobado en las DOS monedas (regla M2). Null mientras es borrador. */
    totalUsd: doublePrecision('total_usd'),
    totalCrc: doublePrecision('total_crc'),
    /**
     * Consecutivo de la factura electronica: uno por proforma. Lo emite un
     * sistema externo; aqui solo se anota. Sin unico, por la misma razon que en
     * el tramite: el numero lo controla otro sistema.
     */
    electronicInvoiceNumber: text('electronic_invoice_number'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('proformas_client_idx').on(t.clientId, t.status),
    index('proformas_status_idx').on(t.status, t.createdAt),
    /** Un numero, una proforma. Parcial: los borradores sin numero no compiten. */
    uniqueIndex('proformas_number_idx')
      .on(t.number)
      .where(sql`${t.number} is not null`),
    /**
     * A LO SUMO UN BORRADOR QUE ACUMULA por cliente, flujo y moneda. Es la regla
     * "todos los paquetes del cliente van al mismo borrador", sostenida por la BD:
     * dos recepciones simultaneas del mismo cliente no pueden abrir dos.
     */
    uniqueIndex('proformas_one_accumulating_idx')
      .on(t.clientId, t.flow, t.currency)
      .where(sql`${t.accumulates} and ${t.status} = 'borrador'`),
    /**
     * Una proforma aprobada o pagada tiene numero, tasa y totales: son lo que la
     * aprobacion congela y lo que el cobro compara. Un UPDATE a mano que dejara
     * uno en blanco produciria un documento que no se puede cobrar.
     */
    check(
      'proformas_approved_frozen',
      sql`${t.status} = 'borrador' or (${t.number} is not null and ${t.exchangeRate} is not null and ${t.totalUsd} is not null and ${t.totalCrc} is not null and ${t.approvedAt} is not null)`,
    ),
    /** Solo acumula un borrador (regla de arriba, dicha tambien como CHECK). */
    check('proformas_accumulates_draft', sql`not ${t.accumulates} or ${t.status} = 'borrador'`),
    check('proformas_rate_positive', sql`${t.exchangeRate} is null or ${t.exchangeRate} > 0`),
    check(
      'proformas_totals_nonneg',
      sql`(${t.totalUsd} is null or ${t.totalUsd} >= 0) and (${t.totalCrc} is null or ${t.totalCrc} >= 0)`,
    ),
    check('proformas_number_positive', sql`${t.number} is null or ${t.number} > 0`),
  ],
);

/**
 * Tramites de cada proforma. La clave primaria es el TRAMITE, no el par: asi un
 * tramite no puede estar en dos proformas a la vez aunque dos operadores lo
 * muevan al mismo tiempo. Moverlo es actualizar `proforma_id`.
 */
export const proformaShipments = pgTable(
  'proforma_shipments',
  {
    shipmentId: uuid('shipment_id')
      .primaryKey()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    proformaId: uuid('proforma_id')
      .notNull()
      .references(() => proformas.id, { onDelete: 'cascade' }),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('proforma_shipments_proforma_idx').on(t.proformaId)],
);

/**
 * Servicios adicionales cargados a la proforma entera. Misma forma que
 * `shipment_costs` y mismas reglas: cada fila es un SNAPSHOT con su etiqueta,
 * su monto, su moneda y su tasa (M2, M5), y el FK al catalogo es solo
 * trazabilidad.
 */
export const proformaCosts = pgTable(
  'proforma_costs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proformaId: uuid('proforma_id')
      .notNull()
      .references(() => proformas.id, { onDelete: 'cascade' }),
    costServiceId: uuid('cost_service_id').references(() => costServices.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    category: costCategoryEnum('category').notNull().default(DEFAULT_COST_CATEGORY),
    electronicInvoiceCode: text('electronic_invoice_code'),
    source: costLineSourceEnum('source').notNull(),
    percentage: doublePrecision('percentage'),
    /** COSTO FACTURADO (el que imprime la proforma). */
    amount: doublePrecision('amount').notNull(),
    /** COSTO REAL; null = igual al facturado. Igual que en `shipment_costs`. */
    realAmount: doublePrecision('real_amount'),
    currency: currencyEnum('currency').notNull(),
    exchangeRate: doublePrecision('exchange_rate').notNull(),
    /**
     * Cobro que produjo la linea: solo la comision por pago con tarjeta. Es la
     * llave de idempotencia del webhook, igual que en `shipment_costs`.
     */
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('proforma_costs_proforma_idx').on(t.proformaId, t.createdAt),
    uniqueIndex('proforma_costs_payment_idx')
      .on(t.proformaId, t.paymentId)
      .where(sql`${t.paymentId} is not null`),
    check('proforma_costs_amount_nonneg', sql`${t.amount} >= 0`),
    check('proforma_costs_real_amount_nonneg', sql`${t.realAmount} is null or ${t.realAmount} >= 0`),
    check('proforma_costs_rate_positive', sql`${t.exchangeRate} > 0`),
    check(
      'proforma_costs_percentage_range',
      sql`${t.percentage} is null or (${t.percentage} >= 0 and ${t.percentage} <= 100)`,
    ),
  ],
);

/** Clave de la unica fila de `proforma_counter`. */
export const PROFORMA_COUNTER_ID = 'global';

/**
 * CONTADOR DEL NUMERO DE PROFORMA. Una fila, leida y avanzada con bloqueo
 * (`SELECT ... FOR UPDATE`) dentro de la misma transaccion que aprueba.
 *
 * Reemplaza a la secuencia de Postgres a proposito: una secuencia no garantiza
 * una serie sin huecos (`nextval` no se deshace si la transaccion falla), y el
 * negocio la pide continua. Con el bloqueo de fila, una aprobacion que falla no
 * consume numero y dos aprobaciones simultaneas salen una detras de otra.
 *
 * `next_number` es el numero que recibira la PROXIMA proforma aprobada. El valor
 * inicial es configurable (se fija antes de salir a produccion).
 */
export const proformaCounter = pgTable(
  'proforma_counter',
  {
    id: text('id').primaryKey().default(PROFORMA_COUNTER_ID),
    nextNumber: integer('next_number').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('proforma_counter_singleton', sql`${t.id} = 'global'`),
    check('proforma_counter_positive', sql`${t.nextNumber} > 0`),
  ],
);

export type ProformaRow = typeof proformas.$inferSelect;
export type NewProformaRow = typeof proformas.$inferInsert;
export type ProformaCostRow = typeof proformaCosts.$inferSelect;
