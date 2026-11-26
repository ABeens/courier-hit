/**
 * Acceso a `provider_webhook_events`: la bitacora y cola de los avisos de Helga.
 */
import { and, asc, eq, inArray, lt, ne, notInArray, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { shipments } from '../shipments/shipments.schema';
import { providerWebhookEvents, type ProviderWebhookEventRow } from './provider-webhooks.schema';

export type WebhookKind = 'package' | 'tracking';

export type WebhookStatus = 'pending' | 'processed' | 'duplicate' | 'ignored' | 'failed';

export const providerWebhooksRepo = {
  /** Guarda el aviso recien llegado. Es lo UNICO que se hace antes de responder. */
  async insert(values: {
    kind: WebhookKind;
    accountCode: string;
    externalId: string;
    hawb: string;
    payload: unknown;
  }): Promise<string> {
    const [row] = await db
      .insert(providerWebhookEvents)
      .values(values)
      .returning({ id: providerWebhookEvents.id });
    if (!row) throw new Error('No se pudo registrar el aviso.');
    return row.id;
  },

  /**
   * La cola: pendientes y fallidos con intentos disponibles, en ORDEN DE LLEGADA.
   * El orden importa: la creacion de un paquete llega antes que sus trackings y
   * tiene que procesarse antes.
   */
  async nextBatch(
    limit: number,
    maxAttempts: number,
    /** Filas ya vistas en esta pasada (fallidas o bloqueadas): no se repiten. */
    exclude: string[],
  ): Promise<ProviderWebhookEventRow[]> {
    return db
      .select()
      .from(providerWebhookEvents)
      .where(
        and(
          inArray(providerWebhookEvents.status, ['pending', 'failed']),
          lt(providerWebhookEvents.attempts, maxAttempts),
          exclude.length > 0 ? notInArray(providerWebhookEvents.id, exclude) : undefined,
        ),
      )
      .orderBy(asc(providerWebhookEvents.receivedAt), asc(providerWebhookEvents.id))
      .limit(limit);
  },

  /**
   * True si ya se proceso ANTES otro aviso con la misma llave de la
   * especificacion. Cuenta cualquier resultado terminal, no solo `processed`:
   * un tracking que se ignoro (p. ej. el paquete ya estaba en aduanas) tambien
   * se considero, y su reenvio es un duplicado.
   */
  async hasHandledSibling(row: { id: string; kind: string; externalId: string }): Promise<boolean> {
    const [hit] = await db
      .select({ id: providerWebhookEvents.id })
      .from(providerWebhookEvents)
      .where(
        and(
          eq(providerWebhookEvents.kind, row.kind),
          eq(providerWebhookEvents.externalId, row.externalId),
          ne(providerWebhookEvents.id, row.id),
          inArray(providerWebhookEvents.status, ['processed', 'duplicate', 'ignored']),
        ),
      )
      .limit(1);
    return Boolean(hit);
  },

  async finish(
    id: string,
    status: Exclude<WebhookStatus, 'pending' | 'failed'>,
    result: string,
    shipmentId: string | null,
  ): Promise<void> {
    await db
      .update(providerWebhookEvents)
      .set({
        status,
        result,
        shipmentId,
        attempts: sql`${providerWebhookEvents.attempts} + 1`,
        processedAt: new Date(),
      })
      .where(eq(providerWebhookEvents.id, id));
  },

  /**
   * Lo que el procesador necesita de un tramite. Consulta propia y no
   * `shipmentsRepo.findById`: esa arrastra los joins de la vista (ruta, proforma,
   * pagos) y no trae la bandera de la prealerta, que aqui hace falta.
   */
  async findShipment(id: string) {
    const [row] = await db
      .select({
        id: shipments.id,
        code: shipments.code,
        clientId: shipments.clientId,
        shipmentType: shipments.shipmentType,
        state: shipments.state,
        tracking: shipments.tracking,
        description: shipments.description,
        content: shipments.content,
        hawb: shipments.hawb,
        weightKg: shipments.weightKg,
        lengthCm: shipments.lengthCm,
        widthCm: shipments.widthCm,
        heightCm: shipments.heightCm,
        helgaPrealertStatus: shipments.helgaPrealertStatus,
      })
      .from(shipments)
      .where(eq(shipments.id, id))
      .limit(1);
    return row ?? null;
  },

  async fail(id: string, error: string): Promise<void> {
    await db
      .update(providerWebhookEvents)
      .set({
        status: 'failed',
        result: error.slice(0, 2000),
        attempts: sql`${providerWebhookEvents.attempts} + 1`,
        processedAt: new Date(),
      })
      .where(eq(providerWebhookEvents.id, id));
  },
};
