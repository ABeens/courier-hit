/**
 * Proforma de un tramite: el documento que se le entrega al cliente.
 * Fuente: `source_docs/Material/Ejemplo de Proforma.xlsx`.
 *
 * TRES reglas del negocio que definen la entidad y que conviene tener juntas:
 *
 * 1. UNA PROFORMA POR TRAMITE. No se agrupan. Por eso no existe un
 *    `ProformaGroup` ni una tabla propia: la proforma ES el tramite, visto desde
 *    la facturacion, y su numero es el consecutivo del tramite.
 *
 *    UNICA EXCEPCION: las cuentas CONSOLIDADAS, que se cobran de una sola vez y
 *    por eso se documentan de una sola vez (`ConsolidatedProformaDto`, mas
 *    abajo). Ahi la unidad no es el tramite sino el GRUPO DE COBRO, y los
 *    tramites que lo componen quedan FUERA del listado de proformas sueltas: el
 *    requisito lo pide explicito ("no se incluira en reportes anteriores") y
 *    ademas evita entregar dos documentos por el mismo dinero.
 * 2. SOLO SOBRE TRAMITES YA FACTURADOS. Sin costos aprobados no hay lineas ni
 *    total que imprimir; pedirla antes es un 409, no una proforma vacia.
 * 3. NO SE GUARDA. Se arma al pedirla, a partir de las lineas de costo, el
 *    cliente y el tramite. Persistirla obligaria a decidir que pasa cuando se
 *    reversan los costos, y la respuesta correcta es que la proforma vieja deja
 *    de existir: no es un asiento contable, es una impresion de un estado.
 *
 * El documento tiene DOS bloques, como en el Excel: los conceptos que se cobran
 * (con su codigo del sistema de factura electronica) y el detalle del envio.
 */
// Solo tipos: la proforma no ejecuta nada de esos modulos, y asi el indice puede
// seguir exportando los reportes antes que los pagos sin crear un ciclo real.
import type { Currency } from '../money/currency';
import type { PaymentMethod, PaymentStatus } from '../payments/payment';

/** Datos del cliente que encabezan la proforma (bloque "DATOS CLIENTE"). */
export interface ProformaClient {
  name: string;
  /** Cedula, solo digitos. */
  idNumber: string;
  phone: string | null;
  /** Direccion en una linea, ya resuelta desde el catalogo territorial. */
  address: string;
  email: string;
}

/**
 * Una linea de concepto de la proforma. Sale 1:1 de una linea de
 * `shipment_costs`; lo que agrega es el COD SIS FE que arrastra del catalogo.
 */
export interface ProformaLine {
  /**
   * CANTIDAD. Siempre 1 con el modelo actual: una linea de costo es un concepto
   * cobrado una vez, no un articulo con unidades. Viaja explicita porque la
   * plantilla la imprime y porque el dia que un concepto se cobre por unidad
   * (dos permisos, tres inspecciones) el campo ya esta.
   */
  quantity: number;
  /** Descripcion del concepto, congelada al cargar el costo. */
  label: string;
  /** COD SIS FE del concepto; null si al servicio no se le asigno ninguno. */
  electronicInvoiceCode: string | null;
  /**
   * Importe del concepto, en la MONEDA DEL DOCUMENTO (`ProformaDto.currency`),
   * convertido con la tasa de su propia linea (regla M5). No se imprime en la
   * moneda de cada linea: una columna con simbolos mezclados no se puede sumar,
   * y el cliente tiene que poder llegar al total contando lo que ve.
   */
  amount: number;
}

/**
 * Bloque "FACTURACION BOLETA ENTREGA": el detalle del envio al que corresponde
 * la factura. En el Excel es una tabla porque la plantilla admite varias filas,
 * pero con una proforma por tramite siempre lleva una.
 */
export interface ProformaShipmentDetail {
  /** HAWB en Paqueteria, AWB/BL en el resto. */
  awb: string | null;
  description: string;
  weightKg: number | null;
  tracking: string;
  /** Flete cobrado (linea de `CostCategory.Flete`). En la moneda del documento. */
  freight: number;
  /** Permisos y demas conceptos trasladados (`CostCategory.Otros`). */
  others: number;
  /** Impuestos (`CostCategory.Impuestos`). */
  taxes: number;
  /** Suma de los tres anteriores mas los honorarios propios: el total facturado. */
  total: number;
  /** Instante de entrega en UTC (ISO 8601), o null si aun no se entrego. */
  deliveredAt: string | null;
}

/** Proforma completa, lista para renderizar. */
export interface ProformaDto {
  shipmentId: string;
  /**
   * Numero de proforma. Es el consecutivo del tramite (`HSX000001000`): la regla
   * "una proforma por tramite" hace innecesaria una secuencia aparte, y tenerla
   * obligaria a explicar por que un tramite tiene dos numeros.
   */
  number: string;
  /** Fecha del documento: cuando se aprobo la factura. UTC, ISO 8601. */
  issuedAt: string;
  /**
   * Tasa de cambio con la que se imprime el total en colones (el "TC" de la
   * esquina del Excel). Es la que quedo congelada en las lineas del tramite, no
   * la vigente de hoy: la proforma tiene que dar el mismo colon que la factura.
   */
  exchangeRate: number;
  /**
   * MONEDA DEL DOCUMENTO: aquella en la que se tramito, es decir la de las lineas
   * de costo (`invoiceCurrency`). Es el importe que manda; el de la otra moneda va
   * de referencia con su TC.
   *
   * No es un detalle de presentacion: un agenciamiento se cotiza y se cobra en
   * colones, y entregarle al cliente una proforma en dolares le obliga a rehacer
   * la conversion para reconocer su propio cobro. Antes el documento se imprimia
   * siempre en dolares y ese era justo el problema.
   */
  currency: Currency;
  client: ProformaClient;
  lines: ProformaLine[];
  /** Total en dolares: la suma de las lineas. */
  totalUsd: number;
  /** El mismo total en colones (`totalUsd × exchangeRate`). */
  totalCrc: number;
  detail: ProformaShipmentDetail;
  /** Consecutivo de la factura electronica, si ya se emitio. */
  electronicInvoiceNumber: string | null;
}

/**
 * Cuantas proformas hay listas para el filtro actual, antes de bajarlas.
 *
 * Es un CONTEO y no un listado a proposito: la pantalla solo necesita decir
 * cuantas va a abrir, y armar las proformas enteras para contarlas costaba tres
 * consultas por tramite. Peor: ese listado venia ya recortado al tope del lote,
 * asi que el numero se quedaba clavado en 200 con cualquier filtro y parecia que
 * el filtro no hacia nada.
 */
export interface ProformaBatchSummary {
  /** Proformas listas en el filtro. Es el total real, sin recortar por el tope. */
  total: number;
  /** Cuantas de esas NO caben en el lote (`total - tope`). 0 = salen todas. */
  omitted: number;
}


// ---------------------------------------------------------------------------
// Proforma CONSOLIDADA (cuentas con tarifa Consolidada)
// ---------------------------------------------------------------------------

/**
 * Un paquete dentro de la proforma consolidada: la fila del bloque de detalle.
 *
 * Es el mismo desglose que `ProformaShipmentDetail` mas lo que identifica al
 * paquete (codigo y total), porque aqui hay varios y el cliente tiene que poder
 * reconocer cual es cual. El peso es el REAL: la tarifa consolidada cobra sin
 * redondear, y una proforma que imprimiera el peso redondeado estaria explicando
 * un cobro con un numero que no lo produce.
 */
export interface ConsolidatedProformaItem {
  shipmentId: string;
  /** Consecutivo de negocio del tramite (`HSX000001000`). */
  code: string;
  /** HAWB en Paqueteria, AWB/BL en el resto. */
  awb: string | null;
  tracking: string;
  description: string;
  /** Peso real de bascula, el que cobra la tarifa consolidada. */
  weightKg: number | null;
  /** Desglose en la moneda del documento (`ConsolidatedProformaDto.currency`). */
  freight: number;
  others: number;
  taxes: number;
  /** Total facturado de ESTE paquete, en la moneda del documento. */
  total: number;
  /** Conceptos cobrados de este paquete, con su COD SIS FE. */
  lines: ProformaLine[];
}

/**
 * Proforma de un GRUPO DE COBRO consolidado: todos los paquetes que se saldaron
 * juntos y el monto total pagado.
 *
 * Se emite contra el grupo (`paymentGroupId`) y no contra el cliente: es lo que
 * la hace reproducible. Un mes despues, "los paquetes consolidados de Fulano" es
 * un conjunto distinto; "los paquetes del cobro del 14 de marzo" es siempre el
 * mismo, que es justo lo que un documento de facturacion tiene que ser.
 *
 * NO SE GUARDA, igual que la proforma suelta: se arma al pedirla, a partir del
 * grupo, sus abonos y las lineas de costo de cada paquete.
 */
export interface ConsolidatedProformaDto {
  paymentGroupId: string;
  /**
   * Numero del documento. Es el id corto del grupo con prefijo (`HSC-XXXXXXXX`):
   * el grupo no tiene consecutivo de negocio propio y darle uno obligaria a una
   * secuencia mas para un documento que ya se identifica solo.
   */
  number: string;
  /** Fecha del documento: cuando se creo el grupo de cobro. UTC, ISO 8601. */
  issuedAt: string;
  /** Tasa congelada del cobro (el "TC" de la esquina). */
  exchangeRate: number;
  /**
   * MONEDA DEL COBRO: en ella se imprime el documento y se expresa lo pagado.
   * Aqui no se deriva de las lineas como en la proforma suelta, sino que es la
   * del grupo: el cobro agrupado ya se hizo en una moneda concreta, y el
   * documento tiene que hablar en la misma que el recibo.
   */
  currency: Currency;
  client: ProformaClient;
  /** Nombre de la tarifa consolidada con la que se cobro. */
  rateName: string;
  items: ConsolidatedProformaItem[];
  /** Suma de los totales de los paquetes, en dolares. */
  totalUsd: number;
  /** El mismo total en colones. */
  totalCrc: number;
  /**
   * Lo efectivamente PAGADO por el grupo (abonos confirmados), en la moneda del
   * cobro. Es el dato que pide el requisito y no tiene por que coincidir con el
   * total si el cobro todavia esta en validacion: por eso van los dos.
   */
  paidAmount: number;
  /** Situacion del cobro agrupado, para no imprimir "pagado" sobre un pendiente. */
  paidStatus: PaymentStatus;
  /** Cuando quedo confirmado el cobro; null si todavia no. */
  paidAt: string | null;
  method: PaymentMethod;
}

/** Fila del listado de proformas consolidadas disponibles. */
export interface ConsolidatedProformaListItem {
  paymentGroupId: string;
  number: string;
  clientName: string;
  clientCode: string;
  issuedAt: string;
  itemCount: number;
  totalUsd: number;
  paidStatus: PaymentStatus;
}

/**
 * Numero del documento consolidado a partir del id del grupo. Punto UNICO del
 * formato: lo imprime el documento y lo lista la pantalla, y dos formas de
 * escribir el mismo numero es como el cliente acaba sin poder buscar el suyo.
 */
export function formatConsolidatedProformaNumber(paymentGroupId: string): string {
  return `HSC-${paymentGroupId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}
