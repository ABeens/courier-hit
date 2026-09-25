/**
 * Los servicios de la proforma REPARTIDOS entre sus tramites, para los reportes
 * (docs/proformas-cambios.html, area 14).
 *
 * Al aprobar, la factura de cada tramite ya incluye su parte de los servicios de
 * la proforma (`allocateProformaInvoices`). Pero los reportes no leen solo el
 * total: desglosan la factura por CATEGORIA (impuestos, otros, honorarios) para
 * calcular costos y margen, y eso sale de las lineas. Sin este reparto, un
 * servicio trasladado cargado a la proforma subiria la factura del tramite sin
 * aparecer como costo, y el reporte lo contaria como margen.
 *
 * Mismo criterio que la aprobacion: en proporcion a lo que cobra cada tramite
 * con sus lineas propias, en la moneda de la proforma, con `splitAmount` (ni se
 * pierde ni se inventa un centimo). Se reparte LINEA POR LINEA para conservar la
 * categoria de cada servicio.
 */
import { CostCategory, splitAmount, totalIn, computeTotals } from '@courier/shared';
import type { Currency } from '@courier/shared';
import { proformasRepo } from './proformas.repo';

/** Una porcion de servicio de la proforma atribuida a un tramite. */
export interface AllocatedCostLine {
  shipmentId: string;
  amount: number;
  currency: Currency;
  exchangeRate: number;
  category: CostCategory;
}

export async function allocatedProformaCosts(shipmentIds: readonly string[]): Promise<AllocatedCostLine[]> {
  const proformaIds = await proformasRepo.billedProformaIdsOf(shipmentIds);
  if (proformaIds.length === 0) return [];

  const [shipmentLines, extras, proformas] = await Promise.all([
    proformasRepo.shipmentLinesOf(proformaIds),
    proformasRepo.proformaLinesOf(proformaIds),
    Promise.all(proformaIds.map((id) => proformasRepo.findById(id))),
  ]);

  const wanted = new Set(shipmentIds);
  const out: AllocatedCostLine[] = [];

  for (const proforma of proformas) {
    if (!proforma) continue;
    const ownExtras = extras.filter((l) => l.proformaId === proforma.id);
    if (ownExtras.length === 0) continue;

    // Pesos: lo que cobra cada tramite con sus lineas propias. La comision de la
    // tarjeta (lineas con `paymentId`) se asento despues de aprobar y no entro en
    // el reparto de la aprobacion: tampoco entra aqui.
    const lines = shipmentLines.filter((l) => l.proformaId === proforma.id && l.paymentId === null);
    const shipments = [...new Set(lines.map((l) => l.shipmentId))];
    const weights = shipments.map((id) =>
      totalIn(computeTotals(lines.filter((l) => l.shipmentId === id)), proforma.currency),
    );

    for (const extra of ownExtras) {
      const shares = splitAmount(extra.amount, weights, extra.currency);
      shipments.forEach((shipmentId, i) => {
        if (!wanted.has(shipmentId) || !shares[i]) return;
        out.push({
          shipmentId,
          amount: shares[i]!,
          currency: extra.currency,
          exchangeRate: extra.exchangeRate,
          category: extra.category,
        });
      });
    }
  }
  return out;
}
