/**
 * La MONEDA DE COBRO de una proforma, vista y elegida desde los editores de
 * costos (el de un tramite y el de los servicios de la proforma).
 *
 * Vive aparte porque la usan los dos editores, y cada uno esta en un modulo que
 * el otro ya importa: aqui no hay ciclo.
 *
 * La regla es de @courier/shared (`canChooseProformaCurrency`): Paqueteria cobra
 * siempre en dolares, y Transporte y Agenciamiento eligen mientras la proforma
 * sea borrador. Cambiarla no convierte ninguna linea: cada una conserva su
 * moneda y su tasa (M2, M5), y la aprobacion congela los totales en las dos
 * monedas como siempre. Lo que cambia es contra que columna se cobra y se salda.
 */
import { canChooseProformaCurrency, isProformaEditable } from '@courier/shared';
import type { Currency, ShipmentCostsDto } from '@courier/shared';
import { ProformaErrors } from '../../core/errors';
import type { ProformaRow } from './proformas.schema';
import { proformasRepo } from './proformas.repo';

/** Lo unico de la proforma que hace falta para decidir sobre su moneda. */
type CurrencyHolder = Pick<ProformaRow, 'id' | 'flow' | 'status' | 'currency'>;

/** Lo que el editor muestra de la moneda: cual es, si se puede cambiar y a cuantos tramites alcanza. */
export async function proformaCurrencyView(
  proforma: CurrencyHolder | null,
): Promise<ShipmentCostsDto['proformaCurrency']> {
  if (!proforma) return null;
  return {
    currency: proforma.currency,
    editable: canChooseProformaCurrency(proforma.flow) && isProformaEditable(proforma.status),
    shipmentCount: await proformasRepo.countShipments(proforma.id),
  };
}

/**
 * Aplica la moneda elegida en el editor. Sin moneda, o con la misma que ya
 * tiene, no hace nada: el guardado normal de las lineas la reenvia tal como la
 * mostro la pantalla, y eso no puede fallar en una proforma de Paqueteria.
 *
 * Se aplica justo ANTES de escribir las lineas, ya con la tasa y las lineas
 * resueltas: si la moneda no se puede cambiar, o si fallaba lo anterior, el
 * operador ve el error sin que se haya guardado la mitad.
 */
export async function applyProformaCurrency(
  proforma: CurrencyHolder | null,
  currency: Currency | undefined,
): Promise<void> {
  if (currency === undefined || proforma?.currency === currency) return;
  if (!proforma || !canChooseProformaCurrency(proforma.flow)) throw ProformaErrors.currencyNotChoosable();
  if (!isProformaEditable(proforma.status)) throw ProformaErrors.notDraft();
  if (!(await proformasRepo.setDraftCurrency(proforma.id, currency))) throw ProformaErrors.changed();
}
