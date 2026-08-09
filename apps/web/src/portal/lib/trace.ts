/**
 * Segunda linea de cada asiento del historial: DONDE esta (o que se esta
 * haciendo con) el tramite en ese estado.
 *
 * `STATE_LABELS` nombra el estado en el vocabulario de la operacion («En
 * Aduanas», «Preparando para envío»); esto lo traduce a lo que el cliente quiere
 * saber al mirar la linea de tiempo, que es donde esta su paquete y quien lo
 * tiene. Son dos textos distintos a proposito: repetir la etiqueta en minuscula
 * debajo de si misma no aporta nada.
 *
 * Vive en el portal y no en `@courier/shared` por lo mismo que `STATE_TONE`: es
 * copy de presentacion, no dominio. La API no lo necesita para nada.
 *
 * Depende del FLOW ademas del estado porque varios estados son comunes a las tres
 * maquinas y no significan lo mismo en cada una: «Prealertado» en Paqueteria es
 * una compra que todavia no llega a Miami, y en Agenciamiento un tramite que
 * acaba de entrar. Un solo texto para los dos mentiria en uno de ellos.
 */
import { Flow, State } from '@courier/shared';
import type { ShipmentDto } from '@courier/shared';
import { awaitingValidation } from '../components/PayFlag';

/**
 * Texto por defecto de cada estado: el que vale cuando el estado significa lo
 * mismo en las tres maquinas. El Record es exhaustivo a proposito, igual que
 * `STATE_TONE`: agregar un State obliga a escribir su linea.
 */
const BASE: Record<State, string> = {
  [State.Prealertado]: 'Trámite registrado',
  [State.FacturacionEnProceso]: 'Calculando el monto a pagar',
  /**
   * Redactado en pasado y sin exigir nada, porque este es el texto del tramo YA
   * SUPERADO: si el tramite salio de aqui es que se pago y se despacho. Mientras
   * el tramite sigue en este estado manda `paymentPlace`, que es quien habla en
   * presente.
   */
  [State.EnBodegaPendientePago]: 'En bodega, a la espera del pago',
  [State.EnRutaEntrega]: 'En camino a tu dirección',
  [State.Entregado]: 'Entregado al destinatario',

  // Transporte (aéreo y marítimo).
  [State.RecoleccionEnProceso]: 'Recolección en origen',
  [State.ProcesoExportacion]: 'Trámites de exportación en origen',
  [State.EnTransitoDestino]: 'En ruta internacional',
  [State.ArriboDestino]: 'Arribó a Costa Rica',
  [State.ProcesoAduanas]: 'Proceso aduanero',

  // Agenciamiento.
  [State.RevisionDocumentos]: 'Verificando la documentación aduanal',
  [State.ExamenPrevio]: 'Inspección previa de la mercancía',
  [State.InspeccionDekra]: 'Inspección técnica (Dekra)',
  [State.PreparandoBorradorDua]: 'Elaborando el DUA',
  [State.PendienteAdelantoImpuestos]: 'A la espera del adelanto de impuestos',

  // Paquetería.
  [State.RecibidoBodegaMiami]: 'Bodega Miami, FL (USA)',
  [State.PreparandoEnvio]: 'Preparando el envío en Miami',
  [State.EnTransitoCostaRica]: 'En ruta internacional',
  [State.EnAduanas]: 'Proceso aduanero',
  [State.DevueltoBodega]: 'De vuelta en nuestra bodega',
};

/**
 * Excepciones por flow. Solo lo que el texto base diria mal: en Paqueteria la
 * prealerta es el aviso de una compra que viaja hacia Miami, no el alta de un
 * tramite en mostrador.
 */
const BY_FLOW: Partial<Record<Flow, Partial<Record<State, string>>>> = {
  [Flow.Paqueteria]: {
    [State.Prealertado]: 'Pendiente de llegada a Miami',
  },
};

/**
 * Que esta pasando AHORA con un tramite parado en «En bodega - Pendiente pago».
 *
 * Es el unico estado cuyo texto no se puede escribir de una vez, porque el estado
 * NO se mueve al pagar: el pago solo levanta la guarda
 * (Condition.RequiresConfirmedPayment) y el tramite se queda ahi hasta que la
 * operacion lo carga a una ruta. Con un texto fijo, el cliente que acaba de pagar
 * seguiria leyendo «pago requerido» durante horas o dias, que es exactamente lo
 * que le hace pagar dos veces.
 *
 * El estado interno no cambia: lo que cambia es lo que se le cuenta al cliente.
 * La respuesta a «¿ya pagó?» sale de `awaitingValidation`, la misma funcion que
 * usan la bandera de cobro y el boton de pagar; responderla distinto aqui seria
 * volver a abrir esa grieta.
 */
function paymentPlace(row: ShipmentDto): string {
  if (row.settled) return 'Pago recibido, preparando el despacho';
  if (awaitingValidation(row)) return 'Pago en validación';
  return 'Retenido — pago requerido';
}

/**
 * Donde esta el tramite en ese estado, dicho para el cliente.
 *
 * `isCurrent` distingue el asiento que describe el PRESENTE (el ultimo, donde el
 * tramite esta parado) de los que describen un tramo ya superado. Solo el primero
 * puede depender de datos vivos como el cobro; a un tramo pasado le corresponde
 * su texto fijo, porque contar el cobro de hoy sobre una etapa que el paquete
 * dejo atras hace semanas seria describir el presente en el lugar del pasado.
 */
export function tracePlace(row: ShipmentDto, state: State, isCurrent: boolean): string {
  if (isCurrent && state === State.EnBodegaPendientePago) return paymentPlace(row);
  return BY_FLOW[row.flow]?.[state] ?? BASE[state];
}
