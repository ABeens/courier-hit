/**
 * Avisos (webhooks) de Helga: recepcion y procesamiento
 * (docs/webhooks-helga-plan.html).
 *
 * Helga, en nombre de LM Express, avisa cada paquete que registra en bodega y
 * cada estado nuevo de su guia. Esto NO reemplaza a las consultas periodicas
 * (descubrimiento por op. E y sincronizacion por op. B): conviven, y estas
 * siguen como respaldo de cualquier aviso que no llegue.
 *
 * Decisiones que viven aqui:
 *
 * 1. RECIBIR ES SOLO GUARDAR. La especificacion corta a los 30 s y, sin
 *    respuesta, no reintenta. Asi que la recepcion hace un INSERT y responde; el
 *    trabajo de verdad va despues, en `drain`.
 * 2. NO SE RECHAZA POR NEGOCIO. Un 4xx detiene los avisos siguientes del paquete
 *    hasta una revision manual. Solo se rechaza la llave invalida y el cuerpo
 *    ilegible; un estado desconocido, un paquete desconocido o un duplicado se
 *    confirman y quedan en la bitacora como `ignored`/`duplicate`.
 * 3. MISMAS REGLAS QUE EL ROBOT. Un tracking avanza con el mismo
 *    `advanceTowards` de la sincronizacion: solo hacia adelante, paso a paso, y
 *    nunca mas alla de En Aduanas. Un paquete sin dueño no avanza.
 * 4. ORDEN DE LLEGADA. Se procesa un aviso a la vez y en el orden en que llego.
 *    Si uno falla por algo tecnico, los siguientes del MISMO paquete esperan al
 *    reintento: un tracking procesado antes que su creacion se descartaria por
 *    "paquete desconocido".
 * 5. LA HORA ES LA NUESTRA. El historial usa la hora del servidor al procesar,
 *    no `fecha_hora` ni `operation_datetime` de Helga (SOW).
 */
import type { ZodType } from 'zod';
import {
  Currency,
  Flow,
  HelgaSyncStatus,
  STATE_LABELS,
  ShipmentType,
  State,
  declaredValueUsdSchema,
  flowForType,
  formatShipmentCode,
  mapProviderState,
  roundMoney,
} from '@courier/shared';
import type { Session } from '@courier/shared';
import { AppError } from '../../core/errors';
import { resolveSystemSession } from '../../core/scheduler/system-session';
import { withLock } from '../../core/scheduler/with-lock';
import { clientsRepo } from '../clients/clients.repo';
import { providerAccountsRepo } from '../provider-accounts/provider-accounts.repo';
import { isBeyondProvider, providerSyncService } from '../shipments/provider-sync.service';
import { shipmentsRepo } from '../shipments/shipments.repo';
import {
  packageEnvelopeSchema,
  readPackage,
  readTracking,
  trackingEnvelopeSchema,
  type WebhookPackage,
} from './provider-webhooks.mapping';
import { providerWebhooksRepo, type WebhookKind } from './provider-webhooks.repo';
import type { ProviderWebhookEventRow } from './provider-webhooks.schema';

/** Candado del procesador. Sigue la numeracion de `JobLock` en jobs.ts. */
export const WEBHOOK_LOCK_KEY = 4807;

/** Intentos por aviso ante fallos TECNICOS (base caida, carrera...). */
const MAX_ATTEMPTS = 5;

/** Filas por consulta a la cola. */
const BATCH = 100;

/** Nota de cada paso de estado que mueve un aviso. Distinta de la del robot. */
const WEBHOOK_NOTE = 'Actualizado por aviso del operador en Miami.';

/** `description` es NOT NULL y Helga puede mandarla vacia. */
const FALLBACK_DESCRIPTION = 'Paquete registrado directamente en el operador de Miami.';

/** Ruta del tramo del proveedor, igual que en `advanceTowards`. */
const PROVIDER_PATH: readonly State[] = [
  State.Prealertado,
  State.RecibidoBodegaMiami,
  State.PreparandoEnvio,
  State.EnTransitoCostaRica,
  State.EnAduanas,
];

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION;
}

/** Cuerpo que no se puede leer: 400 con el motivo, que Helga guarda para revisar. */
function unreadable(message: string): AppError {
  return new AppError('WEBHOOK_UNREADABLE', message, 400);
}

/**
 * Importe del proveedor validado con el MISMO esquema del alta manual (regla
 * M3). Invalido o no positivo = `null`: el importe es accesorio y perder el
 * paquete por el costaria mucho mas.
 */
function providerUsd(value: number | null, schema: ZodType<number>): number | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data <= 0) return null;
  return roundMoney(parsed.data, Currency.USD);
}

/** Resultado de procesar un aviso. */
interface Outcome {
  status: 'processed' | 'duplicate' | 'ignored';
  result: string;
  shipmentId: string | null;
}

type WebhookShipment = NonNullable<Awaited<ReturnType<typeof providerWebhooksRepo.findShipment>>>;

/** Peso, medidas y contenido del aviso que CAMBIAN algo. Lo vacio no borra. */
function dataPatch(shipment: WebhookShipment, pkg: WebhookPackage) {
  const patch: {
    weightKg?: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    content?: string;
  } = {};
  if (pkg.weightKg !== null && pkg.weightKg !== shipment.weightKg) patch.weightKg = pkg.weightKg;
  if (pkg.lengthCm !== null && pkg.lengthCm !== shipment.lengthCm) patch.lengthCm = pkg.lengthCm;
  if (pkg.widthCm !== null && pkg.widthCm !== shipment.widthCm) patch.widthCm = pkg.widthCm;
  if (pkg.heightCm !== null && pkg.heightCm !== shipment.heightCm) patch.heightCm = pkg.heightCm;
  if (pkg.description && pkg.description !== shipment.content) patch.content = pkg.description;
  return patch;
}

function describePatch(patch: Record<string, unknown>): string {
  const keys = Object.keys(patch);
  return keys.length === 0 ? 'sin cambios en los datos' : `datos actualizados: ${keys.join(', ')}`;
}

/** Estado del procesador dentro de ESTE proceso (ver `drain`). */
let running = false;
let again = false;

export const providerWebhooksService = {
  /**
   * Guarda un aviso recien llegado. Lanza 400 si no trae las llaves minimas;
   * todo lo demas se acepta.
   */
  async receive(kind: WebhookKind, accountCode: string, body: unknown): Promise<string> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw unreadable('El cuerpo debe ser un objeto JSON.');
    }

    let externalId: string;
    let hawb: string;
    if (kind === 'package') {
      const parsed = packageEnvelopeSchema.safeParse(body);
      if (!parsed.success) throw unreadable('Falta el campo obligatorio "code" (número de guía).');
      externalId = parsed.data.code as string;
      hawb = externalId;
    } else {
      const parsed = trackingEnvelopeSchema.safeParse(body);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
        throw unreadable(`Campos obligatorios ausentes o inválidos: ${fields}.`);
      }
      externalId = String(parsed.data.evento_id);
      hawb = parsed.data.paquete.hawb as string;
    }

    const id = await providerWebhooksRepo.insert({ kind, accountCode, externalId, hawb, payload: body });

    // Despues de responder. Un fallo aqui no puede volverse un error para Helga:
    // el aviso ya esta guardado y el robot lo barre.
    setImmediate(() => {
      this.drain().catch((err) => console.error('[webhooks] fallo procesando la cola:', err));
    });
    return id;
  },

  /**
   * Vacia la cola. Seguro de llamar muchas veces: dentro del proceso, una
   * llamada mientras otra corre solo pide una vuelta mas; entre procesos manda el
   * advisory lock (si otro lo tiene, este se va y aquel recoge lo nuevo).
   */
  async drain(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await withLock(WEBHOOK_LOCK_KEY, 'helga-webhooks', () => this.processQueue())();
      } while (again);
    } finally {
      running = false;
    }
  },

  /** Una pasada por la cola, en orden de llegada. */
  async processQueue(): Promise<void> {
    const session = await resolveSystemSession();
    if (!session) {
      console.warn('[webhooks] no hay staff activo para firmar el historial; los avisos esperan.');
      return;
    }

    const seen: string[] = [];
    /** HAWB con un aviso fallido en esta pasada: sus siguientes esperan (decision 4). */
    const blocked = new Set<string>();
    let done = 0;

    for (;;) {
      const rows = await providerWebhooksRepo.nextBatch(BATCH, MAX_ATTEMPTS, seen);
      if (rows.length === 0) break;

      for (const row of rows) {
        seen.push(row.id);
        const key = row.hawb.toUpperCase();
        if (blocked.has(key)) continue;

        try {
          const outcome =
            row.kind === 'package'
              ? await this.processPackage(session, row)
              : await this.processTracking(session, row);
          await providerWebhooksRepo.finish(row.id, outcome.status, outcome.result, outcome.shipmentId);
          done += 1;
        } catch (err) {
          blocked.add(key);
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[webhooks] fallo procesando el aviso ${row.id} (${row.kind} ${row.externalId}):`, err);
          await providerWebhooksRepo.fail(row.id, message);
        }
      }
    }

    if (done > 0) console.log(`[webhooks] avisos procesados: ${done}`);
  },

  // --- Creacion de paquete ---------------------------------------------------

  async processPackage(session: Session, row: ProviderWebhookEventRow): Promise<Outcome> {
    const pkg = readPackage(row.payload as Record<string, unknown>);
    const notes: string[] = [];
    if (pkg.shipperCode && pkg.shipperCode.toUpperCase() !== row.accountCode.toUpperCase()) {
      notes.push(`shipper.code ${pkg.shipperCode} distinto de la cuenta de la llave ${row.accountCode}`);
    }
    const suffix = notes.length ? ` (${notes.join('; ')})` : '';

    try {
      return await this.matchOrCreate(session, row, pkg, suffix);
    } catch (err) {
      // Carrera esperada con el descubrimiento (op. E) o una prealerta: alguien
      // ocupo el tracking entre la busqueda y el alta. Se repite la busqueda una
      // vez, que ahora si lo encuentra.
      if (!isUniqueViolation(err)) throw err;
      return this.matchOrCreate(session, row, pkg, suffix);
    }
  },

  async matchOrCreate(
    session: Session,
    row: ProviderWebhookEventRow,
    pkg: WebhookPackage,
    suffix: string,
  ): Promise<Outcome> {
    // 1. Ya existe por HAWB: es un reenvio, o el descubrimiento llego primero.
    const byHawb = await shipmentsRepo.findActiveByHawb(pkg.hawb);
    if (byHawb.length > 1) {
      return {
        status: 'ignored',
        result: `Hay varios trámites activos con el HAWB ${pkg.hawb} (${byHawb.map((s) => s.code).join(', ')}); no se toca ninguno${suffix}.`,
        shipmentId: null,
      };
    }
    if (byHawb[0]) {
      const shipment = await providerWebhooksRepo.findShipment(byHawb[0].id);
      if (!shipment) throw new Error(`El trámite ${byHawb[0].code} desapareció durante el proceso.`);
      const patch = dataPatch(shipment, pkg);
      if (Object.keys(patch).length > 0) await shipmentsRepo.update(shipment.id, patch);
      return {
        status: 'duplicate',
        result: `Ya existía ${shipment.code} con ese HAWB; ${describePatch(patch)}${suffix}.`,
        shipmentId: shipment.id,
      };
    }

    // 2. La prealerta: coincidencia EXACTA del tracking de la transportadora.
    let trackingTaken = false;
    if (pkg.carrierTracking) {
      const prealert = await shipmentsRepo.findActiveByTracking(pkg.carrierTracking);
      if (prealert) {
        const shipment = await providerWebhooksRepo.findShipment(prealert.id);
        if (!shipment) throw new Error(`El trámite ${prealert.code} desapareció durante el proceso.`);
        // Un HAWB distinto ya puesto = es OTRO paquete de Helga con el mismo
        // tracking (transportadoras que reportan solo una parte del numero). No
        // se le pisa el HAWB: se da de alta aparte.
        if (!shipment.hawb || shipment.hawb.toUpperCase() === pkg.hawb.toUpperCase()) {
          return this.linkPrealert(session, shipment, pkg, suffix);
        }
        trackingTaken = true;
      }
    }

    // 3. Paquete nuevo.
    return this.createShipment(session, row, pkg, trackingTaken, suffix);
  },

  /** Asocia el aviso a la prealerta que ya teniamos. */
  async linkPrealert(
    session: Session,
    shipment: WebhookShipment,
    pkg: WebhookPackage,
    suffix: string,
  ): Promise<Outcome> {
    const patch: Parameters<typeof shipmentsRepo.update>[1] = { ...dataPatch(shipment, pkg) };
    if (!shipment.hawb) patch.hawb = pkg.hawb;
    // Helga ya tiene el paquete: reenviar la prealerta (op. C) lo duplicaria alla.
    if (
      shipment.helgaPrealertStatus === HelgaSyncStatus.Pending ||
      shipment.helgaPrealertStatus === HelgaSyncStatus.Failed
    ) {
      patch.helgaPrealertStatus = HelgaSyncStatus.Synced;
    }
    if (Object.keys(patch).length > 0) await shipmentsRepo.update(shipment.id, patch);

    // El aviso llega cuando el paquete esta fisicamente en bodega (SOW).
    let moved = 0;
    if (shipment.clientId && shipment.state === State.Prealertado) {
      moved = await providerSyncService.advanceTowards(
        session,
        shipment,
        flowForType(shipment.shipmentType),
        State.RecibidoBodegaMiami,
        WEBHOOK_NOTE,
      );
    }
    return {
      status: 'processed',
      result:
        `Asociado a la prealerta ${shipment.code} por el tracking ${pkg.carrierTracking}; ` +
        `${describePatch(patch)}${moved > 0 ? `; pasa a ${STATE_LABELS[State.RecibidoBodegaMiami]}` : ''}${suffix}.`,
      shipmentId: shipment.id,
    };
  },

  /**
   * De quien es un paquete nuevo. Cuenta exclusiva (B2B): su cliente
   * consolidado. Cuenta principal: el subcasillero del aviso. Sin dato, sin
   * dueño: va a la Sala de Control.
   */
  async ownerFor(
    accountCode: string,
    subLocker: string | null,
  ): Promise<{ clientId: string | null; providerAccountCode: string | null; why: string }> {
    const exclusive = await providerAccountsRepo.findByCode(accountCode);
    if (exclusive) {
      return exclusive.consolidatedClientId
        ? { clientId: exclusive.consolidatedClientId, providerAccountCode: exclusive.code, why: `cliente consolidado de ${exclusive.code}` }
        : { clientId: null, providerAccountCode: exclusive.code, why: `la cuenta ${exclusive.code} no tiene cliente consolidado` };
    }
    if (!subLocker) return { clientId: null, providerAccountCode: null, why: 'el aviso no trae subcasillero' };
    const client = await clientsRepo.findBySubLocker(subLocker);
    return client
      ? { clientId: client.id, providerAccountCode: null, why: `subcasillero ${subLocker} = ${client.code}` }
      : { clientId: null, providerAccountCode: null, why: `el subcasillero ${subLocker} no es casillero nuestro` };
  },

  async createShipment(
    session: Session,
    row: ProviderWebhookEventRow,
    pkg: WebhookPackage,
    trackingTaken: boolean,
    suffix: string,
  ): Promise<Outcome> {
    const owner = await this.ownerFor(row.accountCode, pkg.subLocker);
    // Sin tracking de transportadora (o ocupado por otro paquete), la llave de
    // cruce es el HAWB: misma regla que el descubrimiento.
    const tracking = !trackingTaken && pkg.carrierTracking ? pkg.carrierTracking : pkg.hawb;
    const code = formatShipmentCode(await shipmentsRepo.nextCodeSequence());

    const id = await shipmentsRepo.insert({
      code,
      clientId: owner.clientId,
      shipmentType: ShipmentType.Paqueteria,
      state: State.RecibidoBodegaMiami,
      tracking,
      description: pkg.description ?? FALLBACK_DESCRIPTION,
      content: pkg.description,
      hawb: pkg.hawb,
      // Peso real de bascula en kg; el redondeo de cobro va en el flete.
      weightKg: pkg.weightKg,
      lengthCm: pkg.lengthCm,
      widthCm: pkg.widthCm,
      heightCm: pkg.heightCm,
      declaredValueUsd: providerUsd(pkg.declaredValueUsd, declaredValueUsdSchema),
      // Ya existe en Helga: no se prealerta de vuelta.
      helgaPrealertStatus: HelgaSyncStatus.Synced,
      providerAccountCode: owner.providerAccountCode,
      createdBy: session.userId,
    });

    const takenNote = trackingTaken ? `; el tracking ${pkg.carrierTracking} ya era de otro trámite` : '';
    return {
      status: 'processed',
      result: owner.clientId
        ? `Creado ${code} (${owner.why})${takenNote}${suffix}.`
        : `Creado ${code} SIN DUEÑO, va a la Sala de Control (${owner.why})${takenNote}${suffix}.`,
      shipmentId: id,
    };
  },

  // --- Tracking --------------------------------------------------------------

  async processTracking(session: Session, row: ProviderWebhookEventRow): Promise<Outcome> {
    const event = readTracking(row.payload as Record<string, unknown>);

    if (await providerWebhooksRepo.hasHandledSibling(row)) {
      return { status: 'duplicate', result: `El evento ${event.eventId} ya se había recibido.`, shipmentId: null };
    }

    const found = await shipmentsRepo.findActiveByHawb(event.hawb);
    if (found.length === 0) {
      return {
        status: 'ignored',
        result: `Paquete desconocido (${event.hawb}); se descarta. Si se registra después, lo actualizan las consultas periódicas.`,
        shipmentId: null,
      };
    }
    if (found.length > 1) {
      return {
        status: 'ignored',
        result: `Hay varios trámites activos con el HAWB ${event.hawb} (${found.map((s) => s.code).join(', ')}); no se toca ninguno.`,
        shipmentId: null,
      };
    }
    const shipment = await providerWebhooksRepo.findShipment(found[0]!.id);
    if (!shipment) throw new Error(`El trámite ${found[0]!.code} desapareció durante el proceso.`);
    const ignored = (result: string): Outcome => ({ status: 'ignored', result, shipmentId: shipment.id });

    const mapping = mapProviderState(event.providerState);
    if (mapping.kind === 'unknown') return ignored(`Estado no reconocido "${event.providerState}"; no cambia el estado.`);
    if (mapping.kind === 'operational') return ignored(`Estado operativo "${event.providerState}"; no representa avance.`);
    if (mapping.kind === 'incident') return ignored(`Incidencia "${event.providerState}"; no cambia el estado.`);

    if (!shipment.clientId) return ignored(`${shipment.code} no tiene dueño; no avanza hasta que se le asigne.`);
    if (flowForType(shipment.shipmentType) !== Flow.Paqueteria) {
      return ignored(`${shipment.code} no es de Paquetería.`);
    }
    if (isBeyondProvider(shipment.state)) {
      return ignored(
        `${shipment.code} está en ${STATE_LABELS[shipment.state]}, tramo manual; el aviso "${event.providerState}" solo queda en la bitácora.`,
      );
    }
    const from = PROVIDER_PATH.indexOf(shipment.state);
    const to = PROVIDER_PATH.indexOf(mapping.state);
    if (to <= from) {
      return ignored(
        `"${event.providerState}" (${STATE_LABELS[mapping.state]}) no es posterior a ${STATE_LABELS[shipment.state]}; no retrocede.`,
      );
    }

    const moved = await providerSyncService.advanceTowards(
      session,
      shipment,
      Flow.Paqueteria,
      mapping.state,
      WEBHOOK_NOTE,
    );
    if (moved === 0) return ignored(`La máquina de estados no permitió avanzar ${shipment.code}.`);
    return {
      status: 'processed',
      result: `${shipment.code}: ${STATE_LABELS[shipment.state]} → ${STATE_LABELS[mapping.state]} (${moved} paso(s)) por "${event.providerState}".`,
      shipmentId: shipment.id,
    };
  },
};
