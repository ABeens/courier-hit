/**
 * Cuando una proforma queda PAGADA (docs/proformas-cambios.html, area 5).
 *
 * La proforma no guarda cuanto se le pago: igual que el tramite, "pagado" se
 * deriva de los abonos confirmados (`isSettled`). Lo que si se guarda es la marca
 * `pagada`, porque cierra la proforma (ya no se corrige) y es lo que filtran la
 * bandeja y el portal. Esta funcion es el UNICO punto que la escribe: la llaman
 * todos los caminos por los que un abono pasa a confirmado (webhook de la
 * pasarela, validacion del staff, deposito registrado ya confirmado).
 *
 * De paso resincroniza el total congelado de la proforma con la suma de las
 * facturas de sus tramites: la comision de un cobro con tarjeta sube la factura
 * de cada tramite al confirmarse, y la proforma tiene que subir con ellas.
 */
import { chargeBasisFor, isSettled, ProformaStatus, sumInvoices } from '@courier/shared';
import { proformasRepo } from './proformas.repo';

export const proformaSettlement = {
  /** Resincroniza las proformas cobradas a las que pertenecen estos tramites. */
  async syncForShipments(shipmentIds: readonly string[]): Promise<void> {
    for (const id of await proformasRepo.billedProformaIdsOf(shipmentIds)) {
      await this.sync(id);
    }
  },

  async sync(proformaId: string): Promise<void> {
    const proforma = await proformasRepo.findById(proformaId);
    if (!proforma || proforma.status === ProformaStatus.Borrador) return;

    const rows = await proformasRepo.settlementRows(proformaId);
    if (rows.length === 0) return;

    const totals = sumInvoices(
      rows.map((r) => ({ usd: r.invoiceTotalUsd ?? 0, crc: r.invoiceTotalCrc ?? 0 })),
    );
    /**
     * Pagada cuando TODOS sus tramites estan saldados, cada uno en la moneda con
     * la que se le cobra. No hay pago parcial de una proforma (regla 6 del SOW):
     * mientras falte uno, sigue aprobada.
     */
    const settled = rows.every((r) => isSettled(r.settlement, chargeBasisFor(r.shipmentType, r)));

    await proformasRepo.applySettlement(proformaId, {
      totals,
      paid: settled && proforma.status === ProformaStatus.Aprobada,
    });
  },
};
