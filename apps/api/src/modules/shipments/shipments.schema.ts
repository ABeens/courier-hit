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
    /**
     * Casillero dueño del tramite. NULL solo en un caso, y es el que justifica
     * que la columna sea opcional: el paquete llego a la bodega de HS Global sin
     * que nadie lo anunciara (ni prealerta del cliente ni aviso del operador de
     * Miami) y todavia espera en la sala de control a que se le identifique dueño.
     *
     * La alternativa era una tabla aparte de "paquetes desconocidos" que al
     * asignarse se convirtiera en tramite. Se prefirio esta: el bulto es el mismo
     * objeto antes y despues de saber de quien es, y duplicar la entidad obligaba
     * a mantener dos altas, dos correcciones y dos historiales del mismo paquete.
     *
     * El precio es que TODO lector debe tolerar el hueco. Lo pagan casi todos sin
     * escribir una linea: las consultas del panel, las entregas, los reportes, la
     * sincronizacion con el proveedor y las notificaciones cruzan contra
     * `clients` con INNER JOIN, asi que una fila sin casillero se queda fuera
     * sola. Los que si lo miran de frente estan enumerados en `ShipmentDto.client`.
     */
    clientId: uuid('client_id').references(() => clients.id),
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
    /**
     * Peso de bascula en kilos, DECIMAL: se guarda tal cual lo dio la balanza.
     *
     * Era entero porque el redondeo hacia arriba del manual (flujo.md L115) se
     * aplicaba al salvar. Se movio al calculo del flete (`billableWeightKg`)
     * porque la tarifa Consolidada cobra el peso real y redondear al guardar lo
     * perdia para siempre. Las tarifas estandar siguen cobrando el kilo
     * redondeado: lo que cambio es CUANDO se redondea, no cuanto se cobra.
     */
    weightKg: doublePrecision('weight_kg'),

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

    // --- Descarte desde la sala de control (solo paquetes sin dueño) ---
    /**
     * Instante del descarte, o NULL en todo tramite vivo. Es un ARCHIVADO, no un
     * borrado: la fila documenta que ese bulto estuvo fisicamente en la bodega, y
     * eso no se tira aunque el paquete acabe en la basura.
     *
     * Las lecturas lo excluyen por defecto (`shipmentsRepo.list`), y el indice
     * unico de tracking activo tambien: un descartado no puede seguir ocupando la
     * guia de un paquete que quiza llegue de verdad manaña.
     */
    discardedAt: timestamp('discarded_at', { withTimezone: true }),
    discardedBy: uuid('discarded_by').references(() => users.id, { onDelete: 'set null' }),
    /** Motivo del descarte; obligatorio al descartar (el schema Zod lo exige). */
    discardReason: text('discard_reason'),

    /** Quien lo dio de alta: el propio cliente (prealerta) o un usuario de staff. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * "Mis paquetes": la consulta mas frecuente del portal, que filtra por
     * casillero y ordena por fecha de ingreso descendente. La fecha va en el
     * indice para que el orden salga de el y no de un sort de todas las filas del
     * cliente (Postgres lo recorre hacia atras para el `desc`).
     *
     * `client_id` sigue siendo el prefijo, asi que este indice tambien sirve todo
     * lo que servia el anterior por casillero a secas (p. ej. `countActiveByClient`).
     *
     * `id` cierra el indice porque el listado ordena por `(created_at, id)`: es el
     * desempate que hace determinista la paginacion (ver `http/pagination`), y sin
     * el en el indice cada pagina del tablero del cliente pagaria un sort.
     */
    index('shipments_client_created_idx').on(t.clientId, t.createdAt, t.id),
    index('shipments_state_idx').on(t.state), // colas de bodega / entrega
    /**
     * Filtro por rango de fechas y, sobre todo, ORDEN del listado paginado. Lleva
     * `id` por lo mismo que el anterior: es la clave de orden completa, asi que
     * Postgres saca la pagina recorriendo el indice hacia atras y se detiene al
     * llegar al `limit`, en vez de ordenar todas las filas del filtro.
     */
    index('shipments_created_at_idx').on(t.createdAt, t.id),
    /**
     * El LES que se escanea en la mesa de bodega (`findActiveByHawb`). La busqueda
     * ignora mayusculas porque el HAWB que llega del proveedor y el que se digita
     * no siempre vienen en la misma caja, asi que el indice es sobre la MISMA
     * expresion `upper(...)`: uno sobre la columna cruda no lo aprovecharia.
     *
     * Parcial sobre las filas que lo tienen: el HAWB es solo de Paqueteria y en el
     * resto de tramites es nulo.
     */
    index('shipments_hawb_upper_idx')
      .on(sql`upper(${t.hawb})`)
      .where(sql`${t.hawb} is not null`),
    /**
     * Prealertas que el robot debe reenviar al proveedor
     * (`findPrealertsToReconcile`). Mismo criterio y misma forma que
     * `clients_unlinked_idx`: parcial sobre las que quedaron a medias, que son un
     * puñado, y ordenado por antiguedad, que es como el robot drena el lote.
     */
    index('shipments_prealert_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.helgaPrealertStatus} in ('pending', 'failed')`),
    /**
     * Un mismo tracking no puede estar activo dos veces, pero SI puede repetirse
     * historicamente (los transportistas reciclan numeros de guia). Por eso el
     * indice unico es PARCIAL: solo aplica a los tramites que aun no terminaron.
     *
     * Los DESCARTADOS tampoco cuentan. Un paquete desconocido que se registro con
     * una guia mal leida y luego se descarto no puede bloquear el alta del
     * paquete legitimo que traiga esa guia: quedaria un error de bodega
     * impidiendo registrar un envio real, y sin forma de resolverlo desde la
     * pantalla.
     */
    uniqueIndex('shipments_active_tracking')
      .on(t.tracking)
      .where(sql`${t.state} <> 'entregado' and ${t.discardedAt} is null`),
    /**
     * Cola de la sala de control: los paquetes vivos que todavia no tienen dueño.
     * Parcial porque son un puñado frente a la tabla entera, y es la unica
     * consulta que barre `client_id is null` (el resto del sistema los descarta
     * por el join).
     */
    index('shipments_unassigned_idx')
      .on(t.createdAt, t.id)
      .where(sql`${t.clientId} is null and ${t.discardedAt} is null`),
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
