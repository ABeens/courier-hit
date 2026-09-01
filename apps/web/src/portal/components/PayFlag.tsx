/**
 * Bandera de cobro de un tramite: pagado, en validacion, o el saldo que falta.
 *
 * Vive aparte de la pildora de estado a proposito. El estado y el pago son dos
 * dimensiones distintas y se cruzan de todas las formas posibles: un tramite en
 * "En bodega - Pendiente pago" puede estar YA cobrado (el cliente pago pero la
 * operacion todavia no lo cargo al camion) y uno "En ruta de entrega" puede
 * llevar saldo si alguien lo adelanto a mano. Teñir la pildora de estado segun el
 * pago habria mezclado las dos cosas en un solo color.
 *
 * SON TRES ESTADOS, NO DOS. "En validacion" existe porque para el cliente no es
 * lo mismo no haber pagado que haber pagado y estar esperando. Con solo dos
 * estados, quien acaba de subir su comprobante ve el saldo entero y entiende que
 * su deposito no llego. El estado del trámite tampoco se lo aclara, porque el
 * pago NO lo mueve: sigue diciendo "Pendiente pago" hasta que la operacion
 * despacha el paquete.
 *
 * No aparece sin factura aprobada: antes de eso no hay nada que cobrar y un
 * "pendiente" en todas las fichas seria ruido, no informacion.
 *
 * Las cifras llegan calculadas por la API; aqui solo se resta el saldo, con la
 * misma funcion compartida que usa el servidor para cobrarlo.
 *
 * HABLA EN COLONES SALVO QUE SE LE DIGA OTRA COSA. Es la moneda de la operacion,
 * la que cuadra contra el banco. El tablero del cliente le pasa `amounts` con la
 * moneda que a EL le toca leer (`billingCurrencyFor`), que en Paqueteria son
 * dolares sin convertir.
 *
 * Lo que NO se lee en colones es si el tramite esta en validacion: esa pregunta
 * se responde en la moneda en que se cobra (`chargeBasisFor`), que es contra la
 * que se cancela la deuda. Por eso la ficha recibe los pares de las dos monedas
 * y no solo la columna que va a pintar.
 */
import type { BillingAmounts, ShipmentType } from '@courier/shared';
import {
  Currency,
  awaitsValidation,
  billingAmounts,
  chargeBasisFor,
  formatMoney,
} from '@courier/shared';

export interface PayState {
  /** Decide en que moneda se cobra y se salda el tramite (`chargeCurrencyFor`). */
  shipmentType: ShipmentType;
  /** Montos de factura congelados en las dos monedas; null = costos sin aprobar. */
  invoiceTotalUsd: number | null;
  invoiceTotalCrc: number | null;
  /** Abonado confirmado, en las dos monedas. */
  settledUsd: number;
  settledCrc: number;
  /** True si lo abonado cubre la factura. Lo decide la API con `isSettled`. */
  settled: boolean;
  /** Abonos subidos y aun sin validar, en las dos monedas. */
  pendingUsd: number;
  pendingCrc: number;
}

interface Props extends PayState {
  /**
   * Cifras ya proyectadas a la moneda en que se van a LEER. Omitirlas deja la
   * bandera en colones, que es lo que ve la operacion.
   *
   * Solo cambia el texto: quien decide si hay saldo, si esta en validacion o si
   * esta pagado siguen siendo los campos en colones de arriba, porque esas son
   * preguntas de contabilidad y tienen una sola respuesta.
   */
  amounts?: BillingAmounts;
}

/**
 * True si lo que falta por cobrar ya esta cubierto por abonos EN VALIDACION.
 *
 * Solo adapta la ficha del listado a `awaitsValidation`, que es donde vive la
 * regla: la bandera, el boton de pagar de la ficha, el formulario del modal y la
 * guarda del servidor se hacen la MISMA pregunta, y responderla distinto en
 * alguno es como el cliente termina pagando dos veces.
 */
export function awaitingValidation(row: PayState): boolean {
  // En la MONEDA DE COBRO, no en la que se esta pintando: un comprobante en
  // dolares comparado contra un saldo en colones no cubre nada, y la ficha
  // ofreceria pagar de nuevo un saldo que ya tiene comprobante encima.
  const basis = chargeBasisFor(row.shipmentType, row);
  const { paid, pending } = billingAmounts(row, basis.currency, row.settled);
  return awaitsValidation(paid, pending, basis);
}

/** La columna en colones, que es la que lee la operacion cuando nadie pide otra. */
function crcAmounts(row: PayState): BillingAmounts {
  return billingAmounts(row, Currency.CRC, row.settled);
}

export function PayFlag({ amounts, ...row }: Props) {
  const { invoiceTotalCrc, settled } = row;
  if (invoiceTotalCrc == null) return null;

  const { currency, invoiceTotal, paid, pending, due } = amounts ?? crcAmounts(row);

  if (settled) {
    return (
      <span className="pay-flag" title={`Cobrado: ${formatMoney(paid, currency)} confirmados.`}>
        Pagado
      </span>
    );
  }

  if (awaitingValidation(row)) {
    return (
      <span
        className="pay-flag is-review"
        title={`Recibimos ${formatMoney(pending, currency)}. Estamos validando el comprobante.`}
      >
        En validación
      </span>
    );
  }

  const abonado = `Abonado ${formatMoney(paid, currency)} de ${formatMoney(invoiceTotal ?? 0, currency)}.`;
  return (
    <span
      className="pay-flag is-due"
      title={
        pending > 0 ? `${abonado} En validación: ${formatMoney(pending, currency)}.` : abonado
      }
    >
      Saldo {formatMoney(due, currency)}
    </span>
  );
}
