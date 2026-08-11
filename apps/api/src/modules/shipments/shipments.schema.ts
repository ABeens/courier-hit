/**
 * Tablas Drizzle del modulo de tramites: `shipments` (la entidad central) y
 * `shipment_events` (su historial de estados, append-only).
 *
 * Los enums salen de @courier/shared (fuente unica): asi la maquina de estados
 * de `workflow/` y el enum de Postgres no pueden divergir.
 *
 * Nota sobre docs/02b-base-de-datos.md §4.5: ese documento describe una tabla
 * `packages` con un enum `package_status` de 8 valores y los costos embebidos.
 * Quedo desactualizado frente a @courier/shared, que modela 5 tipos de tramite,
 * 3 maquinas de estado y 21 estados. Manda el dominio compartido.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { SHIPMENT_TYPE_VALUES, STATE_VALUES } from '@courier/shared';
import { clients, helgaSyncStatusEnum, users } from '../auth/auth.schema';

export const shipmentTypeEnum = pgEnum('shipment_type', SHIPMENT_TYPE_VALUES);
export const shipmentStateEnum = pgEnum('shipment_state', STATE_VALUES);

/**
 * Secuencia del consecutivo de negocio. Arranca en 1000, igual que la del
 * casillero (`hs_client_code_seq`): el primer tramite es HSX000001000.
 */
export const shipmentCodeSeq = pgSequence('hs_shipment_code_seq', { startWith: 1000, increment: 1 });

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Consecutivo `HSX000001000` (clave de negocio, nunca se usa como FK). */
    code: text('code').notNull().unique(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    shipmentType: shipmentTypeEnum('shipment_type').notNull(),
    /**
     * Estado actual. El flow NO se guarda: se deriva del tipo con `flowForType`.
     * Persistirlo permitiria que tipo y flow se desincronizaran.
     */
    state: shipmentStateEnum('state').notNull(),
    /** Tracking (Paqueteria) o AWB/BL (Transporte y Agenciamiento). */
    tracking: text('tracking').notNull(),
    description: text('description').notNull(),

    // --- Solo Paqueteria ---
    store: text('store'),
    carrier: text('carrier'),
    hawb: text('hawb'),
    /** Peso en kilos, entero: se redondea hacia arriba al guardar (flujo.md L115). */
    weightKg: integer('weight_kg'),

    /**
     * Dimensiones en centimetros, tal como las reporta el proveedor (op. B
     * `Largo_cm`/`Ancho_cm`/`Alto_cm`, op. E `largo`/`ancho`/`alto`). Solo
     * informativas hoy: NO entran en ningun calculo de factura.
     *
     * Se guardan porque el proveedor ya las manda en cada consulta y descartarlas
     * significaba no tenerlas el dia que la tarifa las necesite: el historico no
     * se puede reconstruir hacia atras, la op. B solo responde por el paquete
     * mientras esta en su tramo.
     */
    lengthCm: doublePrecision('length_cm'),
    widthCm: doublePrecision('width_cm'),
    heightCm: doublePrecision('height_cm'),
    /**
     * Peso volumetrico en kilos (`Peso_volumen` de la op. B). Decimal, a
     * diferencia de `weightKg`: es un calculo del proveedor, no el peso de bascula
     * que redondeamos para facturar. Informativo, como las dimensiones.
     */
    volumetricWeightKg: doublePrecision('volumetric_weight_kg'),

    // --- Datos declarados para la prealerta del proveedor (Helga), solo Paqueteria ---
    /**
     * Valor comercial declarado, en USD (moneda explicita en el nombre, regla M2;
     * la paqueteria se cotiza solo en dolares). Lo captura el cliente al prealertar
     * y alimenta `valor_comercial` de la prealerta del proveedor. No es un monto
     * transaccional: no lleva tasa de cambio (M5 no aplica), como invoiceTotalUsd.
     * doublePrecision por consistencia con el resto de importes del esquema (legado).
     */
    declaredValueUsd: doublePrecision('declared_value_usd'),
    /** Valor asegurado, en USD. Solo staff; null = no indicado (el proveedor asume 0). */
    insuredValueUsd: doublePrecision('insured_value_usd'),
    /** Posicion arancelaria del contenido. Solo staff; null = no se conoce (se omite ante el proveedor). */
    tariffPosition: text('tariff_position'),
    /** Retener el paquete en la bodega del proveedor. Solo staff; null/false = no retener. */
    retain: boolean('retain'),

    /**
     * Documento que acompaña al tramite (la factura de la compra, tipicamente).
     * Lo adjunta el cliente al prealertar —o el staff despues— y es OPCIONAL: la
     * prealerta sin documento sigue siendo valida, solo obliga a pedirlo luego.
     *
     * Guarda la CLAVE OPACA del almacen, no una ruta ni el nombre original (ver
     * `core/storage.ts`): el dia que el driver pase a S3 esta columna no cambia.
     * Los formatos aceptados son los de `DOCUMENT_ATTACHMENT` (PDF, Word y
     * similares); las imagenes se rechazan en el borde.
     */
    documentFileKey: text('document_file_key'),

    // --- Solo Transporte y Agenciamiento ---
    warehouse: text('warehouse'),
    dua: text('dua'),

    // --- Facturacion, comun a los dos flujos ---
    /**
     * Notas para facturar. Nacio como campo de Transporte y Agenciamiento porque
     * asi lo listaba el manual, pero el reporte las pide en los DOS flujos
     * (campo 20 de Paqueteria, 19 de Agenciamiento) y facturar un paquete
     * necesita las mismas anotaciones. La columna no cambia; lo que cambio es que
     * la coherencia tipo <-> campo ya no la excluye en Paqueteria.
     */
    billingNotes: text('billing_notes'),
    /**
     * Consecutivo de la FACTURA ELECTRONICA (campo FE del reporte). Lo emite un
     * sistema externo; aqui solo se anota para poder cruzar el tramite con esa
     * factura. Null hasta que se emite.
     *
     * Sin indice unico a proposito: el numero lo controla el sistema de
     * facturacion, no nosotros, y un unique nuestro convertiria un dedazo suyo en
     * un error que bloquea al operador en vez de una correccion.
     */
    electronicInvoiceNumber: text('electronic_invoice_number'),

    // --- Snapshot de la factura (se congela al APROBAR los costos) ---
    /**
     * Total aprobado, congelado en AMBAS monedas (regla M2: nunca una cifra sin
     * moneda). Se derivan de las lineas de `shipment_costs` con `computeTotals`,
     * cada una con su propia tasa; aqui quedan como el monto de factura que
     * exige la guarda Condition.RequiresInvoiceAmount para pasar a
     * "En bodega - Pendiente pago". Null mientras no se haya aprobado.
     */
    invoiceTotalUsd: doublePrecision('invoice_total_usd'),
    invoiceTotalCrc: doublePrecision('invoice_total_crc'),
    /**
     * Tarifa de transporte internacional (USD por libra) VIGENTE al aprobar los
     * costos. Solo Paqueteria; null en el resto y mientras no se apruebe.
     *
     * Es un snapshot por la misma razon que el total de factura: el campo 21 del
     * reporte (TRANSPORTE INTL) se calcula con esta tarifa, y si el reporte la
     * leyera de Configuración, subir el flete en marzo cambiaria el margen de
     * todos los paquetes de enero. El costo de un envio es el que fue el dia que
     * se facturo, no el de hoy.
     *
     * No es un monto transaccional sino un precio unitario de referencia: no
     * lleva moneda por columna (va en el nombre, regla M2) ni tasa de cambio
     * (M5 no aplica), igual que `client_rates.price_per_kg`.
     */
    freightRateUsdPerLb: doublePrecision('freight_rate_usd_per_lb'),
    costsApprovedAt: timestamp('costs_approved_at', { withTimezone: true }),
    costsApprovedBy: uuid('costs_approved_by').references(() => users.id, { onDelete: 'set null' }),

    // --- Replicacion de la prealerta ante el proveedor (Helga) ---
    /**
     * Estado de la replicacion de esta prealerta en Helga. Reusa el enum del
     * casillero (`helga_sync_status`). `null` = no aplica (solo Paqueteria se
     * prealerta). Nace 'pending'; el intento inmediato la deja 'synced' o
     * 'failed', y si el casillero aun no esta enlazado queda 'pending' para que
     * la reconciliacion la reenvie. La misma red que el casillero, pero por
     * tramite. Nota: si nunca se replica, la sincronizacion por tracking la
     * recupera igual cuando el paquete llega a bodega (no es load-bearing).
     */
    helgaPrealertStatus: helgaSyncStatusEnum('helga_prealert_status'),
    /**
     * Id de la prealerta EN Helga (`data.Id` de la op. C). Es lo unico que permite
     * BORRARLA alli (op. F, `DELETE /api/casillero/prealertas/{id}`): su API no
     * tiene forma de encontrar una prealerta por tracking.
     *
     * Sin esto, cambiar el tracking de un tramite dejaba una prealerta huerfana en
     * el proveedor para siempre. Texto y no entero: el resto de ids del proveedor
     * se guardan asi (`clients.helga_client_id`) y nunca hacemos aritmetica con el.
     */
    helgaPrealertId: text('helga_prealert_id'),
    /** Intentos de replicacion ya realizados; 0 si nunca se intento. */
    helgaPrealertAttempts: integer('helga_prealert_attempts').notNull().default(0),
    /** Ultimo error del proveedor al replicar; para diagnostico de la reconciliacion. */
    helgaPrealertError: text('helga_prealert_error'),

    /** Quien lo dio de alta: el propio cliente (prealerta) o un usuario de staff. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shipments_client_idx').on(t.clientId), // "mis paquetes"
    index('shipments_state_idx').on(t.state), // colas de bodega / entrega
    index('shipments_created_at_idx').on(t.createdAt), // filtro por rango de fechas
    /**
     * Un mismo tracking no puede estar activo dos veces, pero SI puede repetirse
     * historicamente (los transportistas reciclan numeros de guia). Por eso el
     * indice unico es PARCIAL: solo aplica a los tramites que aun no terminaron.
     */
    uniqueIndex('shipments_active_tracking')
      .on(t.tracking)
      .where(sql`${t.state} <> 'entregado'`),
  ],
);

/**
 * Historial de estados. Append-only: nunca se actualiza ni se borra. Cada alta
 * escribe su primer evento (Prealertado) y cada avance agrega uno.
 */
export const shipmentEvents = pgTable(
  'shipment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    state: shipmentStateEnum('state').notNull(),
    /** Comentario del evento (obligatorio al devolver a bodega: Condition.RequiresComment). */
    note: text('note'),
    /** Quien lo disparo; null = el sistema (p. ej. sincronizacion con el proveedor). */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('shipment_events_shipment_idx').on(t.shipmentId, t.createdAt)],
);

export type ShipmentRow = typeof shipments.$inferSelect;
export type NewShipmentRow = typeof shipments.$inferInsert;
export type ShipmentEventRow = typeof shipmentEvents.$inferSelect;
