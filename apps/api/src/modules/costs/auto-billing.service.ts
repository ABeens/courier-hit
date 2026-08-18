/**
 * Facturacion automatica de las tarifas SIN revision (solicitud de cambio OPS-003).
 *
 * La tarifa del casillero decide si el paquete ocupa que alguien lo mire antes de
 * cobrarlo:
 *   - `requiresBillingReview = true`  -> el tramite se queda en "Facturacion en
 *     proceso" y espera a que un operativo o un administrador le cargue los costos
 *     adicionales y apruebe. Es el camino manual de siempre.
 *   - `requiresBillingReview = false` (todas las tarifas de hoy) -> no hay costos
 *     adicionales que agregarle: el sistema le cotiza el flete, congela la factura
 *     y el tramite sigue solo hasta "En bodega - Pendiente pago".
 *
 * Vive aparte de `costs.service` a proposito. Esto NO es una accion de usuario
 * sobre la pantalla de costos, es un efecto de que el paquete entre a facturacion,
 * asi que no pasa por `assertCanCost`: el operativo de bodega que escanea el bulto
 * no tiene por que poder cargar costos. Ademas, colgarlo de `costs.service` haria
 * un ciclo de imports con `transitions.service`, que es quien lo llama.
 *
 * NADA de lo que comprueba aqui es un error del usuario: si falta el peso, la
 * tarifa o la tasa de cambio, el tramite se queda donde estaba y el operativo lo
 * factura a mano. Recibir un paquete nunca falla por no poder cobrarlo solo.
 */
import {
  Flow,
  categoryForLine,
  computeTotals,
  costLineExchangeRateSchema,
  flowForType,
} from '@courier/shared';
import type { Session } from '@courier/shared';
import { clientsRepo } from '../clients/clients.repo';
import { settingsRepo } from '../settings/settings.repo';
import { costsRepo } from './costs.repo';
import { buildFreight } from './freight';

/** Lo que hace falta del tramite para decidir si se factura solo. */
interface BillingSubject {
  id: string;
  clientId: string | null;
  shipmentType: Parameters<typeof flowForType>[0];
  weightKg: number | null;
}

export const autoBillingService = {
  /**
   * Factura sola la entrada a "Facturacion en proceso" cuando la tarifa del
   * casillero no ocupa revision. Devuelve `true` si dejo la factura congelada (y
   * por tanto el tramite ya puede avanzar a cobro), `false` si toca a mano.
   *
   * `session` es quien escaneo el paquete: queda como autor de las lineas y de la
   * aprobacion. La factura la arma el sistema, pero la traza apunta a la persona
   * que provoco el movimiento, no a un usuario fantasma.
   */
  async tryAutoInvoice(session: Session, shipment: BillingSubject): Promise<boolean> {
    // Solo Paqueteria: el cobro automatico ES el flete por kg, y ni Transporte ni
    // Agenciamiento lo tienen. Ahi todo el importe se digita.
    if (flowForType(shipment.shipmentType) !== Flow.Paqueteria) return false;
    if (shipment.clientId === null) return false;

    const rate = await clientsRepo.rateFor(shipment.clientId);
    if (!rate || rate.requiresBillingReview) return false;

    /**
     * No se pisa trabajo ajeno. Si ya hay lineas cargadas o una factura aprobada,
     * este tramite ya paso por facturacion (una correccion de estado lo devolvio,
     * o el operador se adelanto): rehacerlo borraria lo que alguien cargo a mano.
     */
    const [existing, approval] = await Promise.all([
      costsRepo.listLines(shipment.id),
      costsRepo.approval(shipment.id),
    ]);
    if (existing.length > 0 || approval?.approvedAt) return false;

    const freight = await buildFreight({ clientId: shipment.clientId, weightKg: shipment.weightKg });
    if (!freight) return false; // sin peso (o sin tarifa) no hay nada que cobrar todavia

    /**
     * La tasa es la vigente del sistema, la misma que se le impondria a quien
     * cargue los costos a mano sin permiso para fijarla (regla M5: la linea guarda
     * su testigo de conversion). Sin tasa valida no se factura solo.
     */
    const checked = costLineExchangeRateSchema.safeParse(await settingsRepo.currentExchangeRate());
    if (!checked.success) return false;

    const lines = await costsRepo.replaceLines(shipment.id, [
      {
        shipmentId: shipment.id,
        costServiceId: null,
        label: freight.label,
        category: categoryForLine(freight.source, null),
        electronicInvoiceCode: null,
        source: freight.source,
        percentage: null,
        amount: freight.amount,
        currency: freight.currency,
        exchangeRate: checked.data,
        createdBy: session.userId,
      },
    ]);

    // Mismo cierre que `costsService.approve`: total en las dos monedas y la
    // tarifa de flete internacional vigente, congelada para el reporte de margen.
    await costsRepo.freezeInvoice(
      shipment.id,
      computeTotals(lines),
      session.userId,
      await settingsRepo.currentFreightRate(),
    );
    return true;
  },
};
