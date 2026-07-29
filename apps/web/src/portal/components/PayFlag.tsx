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
 */
import { Currency, formatMoney, outstandingCrc } from '@courier/shared';

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

/**
 * True si lo que falta por cobrar ya esta cubierto por abonos EN VALIDACION.
 *
 * Exportado porque quien pinta la bandera y quien decide si ofrece el boton de
 * pagar se estan haciendo la misma pregunta, y responderla distinto es como el
 * cliente termina pagando dos veces.
 *
 * Un abono parcial en validacion no cuenta: el trámite sigue teniendo saldo que
 * alguien tiene que pagar.
 */
export function awaitingValidation(row: PayState): boolean {
  if (row.settled || row.invoiceTotalCrc == null || row.pendingCrc <= 0) return false;
  return row.pendingCrc >= outstandingCrc(row.settledCrc, row.invoiceTotalCrc);
}

export function PayFlag(row: PayState) {
  const { invoiceTotalCrc, settledCrc, settled, pendingCrc } = row;
  if (invoiceTotalCrc == null) return null;

  if (settled) {
    return (
      <span
        className="pay-flag"
        title={`Cobrado: ${formatMoney(settledCrc, Currency.CRC)} confirmados.`}
      >
        Pagado
      </span>
    );
  }

  if (awaitingValidation(row)) {
    return (
      <span
        className="pay-flag is-review"
        title={`Recibimos ${formatMoney(pendingCrc, Currency.CRC)}. Estamos validando el comprobante.`}
      >
        En validación
      </span>
    );
  }

  const abonado = `Abonado ${formatMoney(settledCrc, Currency.CRC)} de ${formatMoney(invoiceTotalCrc, Currency.CRC)}.`;
  return (
    <span
      className="pay-flag is-due"
      title={
        pendingCrc > 0
          ? `${abonado} En validación: ${formatMoney(pendingCrc, Currency.CRC)}.`
          : abonado
      }
    >
      Saldo {formatMoney(outstandingCrc(settledCrc, invoiceTotalCrc), Currency.CRC)}
    </span>
  );
}
