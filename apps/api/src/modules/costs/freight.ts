/**
 * Flete de Paqueteria: peso x precio por kg de la TARIFA EFECTIVA del casillero.
 *
 * Vive en su propio modulo porque lo necesitan DOS caminos que no se pueden
 * importar entre si: la carga manual de costos (`costs.service`) y la facturacion
 * automatica de las tarifas sin revision (`auto-billing.service`, que cuelga de
 * `transitions.service`). Dejarlo en cualquiera de los dos crearia un ciclo.
 */
import { CostCategory, CostLineSource, roundMoney } from '@courier/shared';
import type { SuggestedCostLine } from '@courier/shared';
import { clientsRepo } from '../clients/clients.repo';

/** Lo minimo que hace falta del tramite para cotizar el flete. */
export interface FreightSubject {
  clientId: string;
  weightKg: number | null;
}

/** Linea de flete ya resuelta: a diferencia de una sugerencia, trae importe. */
export type FreightLine = SuggestedCostLine & { amount: number };

/**
 * Linea de flete del tramite, o `null` si todavia no se puede cotizar.
 *
 * Se marca `auto: true` porque NO es una opcion del catalogo: es el cobro base
 * del servicio y entra solo en la factura. Null solo si el tramite todavia no
 * tiene peso (sin peso no hay flete que calcular) o si no hubo tarifa alguna.
 */
export async function buildFreight(row: FreightSubject): Promise<FreightLine | null> {
  if (!row.weightKg) return null;

  // Tarifa asignada al casillero o, si quedo sin ninguna, la por defecto.
  const rate = await clientsRepo.rateFor(row.clientId);
  if (!rate) return null;

  const detail = `${row.weightKg} kg × ${rate.pricePerKg} ${rate.currency}/kg`;
  return {
    costServiceId: null,
    label: `Flete (${rate.rateName})`,
    category: CostCategory.Flete,
    source: CostLineSource.Freight,
    percentage: null,
    amount: roundMoney(row.weightKg * rate.pricePerKg, rate.currency),
    currency: rate.currency,
    detail: rate.isFallback ? `${detail} · tarifa por defecto` : detail,
    auto: true,
  };
}
