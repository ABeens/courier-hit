/**
 * BACKFILL: pone en proformas los tramites que se facturaron por fuera del modulo.
 *
 * Los seeds (demo y masivo) facturan escribiendo directo en la tabla de tramites,
 * igual que antes del modulo de proformas. Sin este paso esos tramites quedarian
 * facturados pero sin proforma: no aparecerian en la bandeja ni se podrian pagar
 * (todo se cobra por proforma). Tambien sirve para una base de desarrollo que
 * tenia tramites facturados antes de la migracion 0041.
 *
 * Dos casos:
 *   1. Tramite con la factura ya congelada y sin proforma: se envuelve en una
 *      proforma APROBADA propia (una por tramite, que es como se facturaba), con
 *      numero de la serie, el total congelado y la fecha de aprobacion original.
 *      Si sus pagos ya lo cubren, queda PAGADA.
 *   2. Tramite en "Facturacion en proceso" sin factura ni proforma: entra a su
 *      borrador como si acabara de llegar (`proformaDraftsService.onEnterBilling`).
 *
 * Es idempotente: solo toca tramites que no estan en ninguna proforma.
 *
 * Con `dryRun` solo cuenta lo que haria y no escribe nada: es lo que se corre
 * primero contra produccion para ver el alcance antes de aplicarlo.
 */
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  Principal,
  ProformaStatus,
  Role,
  State,
  exchangeRateSchema,
  flowForType,
  proformaCurrencyFor,
} from '@courier/shared';
import type { Session } from '@courier/shared';
import { db } from '../../core/db';
import { users } from '../auth/auth.schema';
import { shipments } from '../shipments/shipments.schema';
import { proformaDraftsService } from './proforma-drafts.service';
import { proformaSettlement } from './proforma-settlement';
import { proformasRepo } from './proformas.repo';
import { proformaShipments, proformas } from './proformas.schema';

/** Tramites que todavia no estan en ninguna proforma. */
const notInProforma = sql`not exists (select 1 from proforma_shipments ps where ps.shipment_id = ${shipments.id})`;

export async function backfillProformas(
  options: { dryRun?: boolean } = {},
): Promise<{ approved: number; drafts: number }> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, Role.Admin))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!admin) return { approved: 0, drafts: 0 };
  const session: Session = { sessionId: 'backfill', userId: admin.id, principal: Principal.Staff, role: Role.Admin };

  // --- 1. Facturados sin proforma ---
  const billed = await db
    .select({
      id: shipments.id,
      clientId: shipments.clientId,
      shipmentType: shipments.shipmentType,
      invoiceTotalUsd: shipments.invoiceTotalUsd,
      invoiceTotalCrc: shipments.invoiceTotalCrc,
      costsApprovedAt: shipments.costsApprovedAt,
      costsApprovedBy: shipments.costsApprovedBy,
    })
    .from(shipments)
    .where(
      and(
        isNotNull(shipments.costsApprovedAt),
        isNotNull(shipments.clientId),
        isNotNull(shipments.invoiceTotalUsd),
        isNotNull(shipments.invoiceTotalCrc),
        isNull(shipments.discardedAt),
        notInProforma,
      ),
    )
    .orderBy(asc(shipments.costsApprovedAt), asc(shipments.code));

  let approved = 0;
  for (const s of billed) {
    const usd = s.invoiceTotalUsd ?? 0;
    const crc = s.invoiceTotalCrc ?? 0;
    // Tasa del documento: el cociente de la propia factura (M5); sin el, no se inventa.
    const rate = exchangeRateSchema.safeParse(usd > 0 && crc > 0 ? crc / usd : null);
    if (!rate.success) continue;
    if (options.dryRun) {
      approved++;
      continue;
    }

    const id = await db.transaction(async (tx) => {
      const [number] = await proformasRepo.takeNumbers(tx, 1);
      const [created] = await tx
        .insert(proformas)
        .values({
          clientId: s.clientId!,
          flow: flowForType(s.shipmentType),
          currency: proformaCurrencyFor(s.shipmentType),
          status: ProformaStatus.Aprobada,
          accumulates: false,
          number: number!,
          exchangeRate: rate.data,
          totalUsd: usd,
          totalCrc: crc,
          approvedAt: s.costsApprovedAt!,
          approvedBy: s.costsApprovedBy ?? admin.id,
          createdBy: admin.id,
          createdAt: s.costsApprovedAt!,
        })
        .returning({ id: proformas.id });
      await tx.insert(proformaShipments).values({ proformaId: created!.id, shipmentId: s.id, addedBy: admin.id });
      return created!.id;
    });
    // Pagada si sus abonos ya la cubren.
    await proformaSettlement.sync(id);
    approved++;
  }

  // --- 2. En facturacion sin factura ni proforma ---
  const pending = await db
    .select({
      id: shipments.id,
      clientId: shipments.clientId,
      shipmentType: shipments.shipmentType,
      weightKg: shipments.weightKg,
      costsApprovedAt: shipments.costsApprovedAt,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.state, State.FacturacionEnProceso),
        isNull(shipments.costsApprovedAt),
        isNotNull(shipments.clientId),
        isNull(shipments.discardedAt),
        notInProforma,
      ),
    )
    .orderBy(asc(shipments.createdAt));

  if (!options.dryRun) for (const s of pending) await proformaDraftsService.onEnterBilling(session, s);

  return { approved, drafts: pending.length };
}
