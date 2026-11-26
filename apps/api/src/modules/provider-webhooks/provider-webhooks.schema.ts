/**
 * Bitacora de los avisos (webhooks) que manda Helga (docs/webhooks-helga-plan.html).
 *
 * Es la AUDITORIA INTERNA que pide el SOW: cada aviso recibido queda aqui con su
 * contenido original, la hora de recepcion y el resultado del procesamiento,
 * aunque no haya cambiado nada en la plataforma (duplicado, estado desconocido,
 * paquete en el tramo manual...).
 *
 * TAMBIEN ES LA COLA. La recepcion solo inserta la fila y responde; el
 * procesador la toma despues (`status = 'pending'`). Asi la respuesta a Helga no
 * depende de cuanto tarde el procesamiento, y un reinicio del contenedor no
 * pierde nada: lo que quedo pendiente lo barre el robot.
 *
 * Se guarda CADA recepcion, incluidas las repetidas: el duplicado se detecta al
 * procesar (`external_id`), no se impide con un indice unico. Un indice unico
 * obligaria a responder algo distinto a un reenvio, y la bitacora perderia
 * justamente el dato de que Helga lo mando dos veces.
 */
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { shipments } from '../shipments/shipments.schema';

export const providerWebhookEvents = pgTable(
  'provider_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `package` (creacion de paquete) o `tracking` (nuevo estado). */
    kind: text('kind').notNull(),
    /** Cuenta Miami a la que pertenece la llave con la que entro (`SJO008835`). */
    accountCode: text('account_code').notNull(),
    /**
     * Llave de idempotencia de la especificacion: `code` en la creacion y
     * `evento_id` en el tracking (como texto).
     */
    externalId: text('external_id').notNull(),
    /** HAWB del paquete (`code` / `paquete.hawb`). Ordena y bloquea por paquete. */
    hawb: text('hawb').notNull(),
    /** Cuerpo original, tal cual llego. */
    payload: jsonb('payload').notNull(),
    /** Hora de recepcion del servidor (UTC). Es la que vale, no la de Helga. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** pending · processed · duplicate · ignored · failed */
    status: text('status').notNull().default('pending'),
    /** Que se hizo o por que no se hizo nada, en texto para la persona que revise. */
    result: text('result'),
    /** Tramite creado o tocado, si lo hubo. */
    shipmentId: uuid('shipment_id').references(() => shipments.id, { onDelete: 'set null' }),
    /** Veces que se intento procesar. Solo sube por fallos tecnicos. */
    attempts: integer('attempts').notNull().default(0),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    /** La cola: lo pendiente o fallido, en orden de llegada. */
    index('provider_webhook_events_queue_idx')
      .on(t.receivedAt, t.id)
      .where(sql`${t.status} in ('pending', 'failed')`),
    /** Deteccion de duplicados por llave de la especificacion. */
    index('provider_webhook_events_external_idx').on(t.kind, t.externalId),
    /** Consultar la historia de avisos de un paquete. */
    index('provider_webhook_events_hawb_idx').on(sql`upper(${t.hawb})`),
  ],
);

export type ProviderWebhookEventRow = typeof providerWebhookEvents.$inferSelect;
