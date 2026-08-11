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
 * HABLA EN COLONES SALVO QUE SE LE DIGA OTRA COSA. Es la moneda de la operacion:
 * la que cuadra contra el banco y la que decide si el tramite esta saldado. El
 * tablero del cliente le pasa `amounts` con la moneda que a EL le toca leer
 * (`billingCurrencyFor`), que en Paqueteria son dolares sin convertir.
 */
import type { BillingAmounts } from '@courier/shared';
import { Currency, awaitsValidation, billingAmounts, formatMoney } from '@courier/shared';

export interface PayState {
  /** Monto de factura congelado; null = costos aun sin aprobar. */
  invoiceTotalCrc: number | null;
  /** Abonado confirmado, en colones. */
  settledCrc: number;
  /** True si lo abonado cubre la factura. */
  settled: boolean;
  /** Abonos subidos y aun sin validar, en colones. */
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
  return awaitsValidation(row.settledCrc, row.pendingCrc, row.invoiceTotalCrc);
}

/** Lo que trae `PayState` es la columna en colones; asi se lee como cualquier otra. */
function crcAmounts(row: PayState): BillingAmounts {
  return billingAmounts(
    {
      invoiceTotalCrc: row.invoiceTotalCrc,
      settledCrc: row.settledCrc,
      pendingCrc: row.pendingCrc,
      invoiceTotalUsd: null,
      settledUsd: 0,
      pendingUsd: 0,
    },
    Currency.CRC,
    row.settled,
  );
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
