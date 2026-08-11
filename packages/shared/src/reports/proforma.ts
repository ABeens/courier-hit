/**
 * Proforma de un tramite: el documento que se le entrega al cliente.
 * Fuente: `source_docs/Material/Ejemplo de Proforma.xlsx`.
 *
 * TRES reglas del negocio que definen la entidad y que conviene tener juntas:
 *
 * 1. UNA PROFORMA POR TRAMITE. No se agrupan. Por eso no existe un
 *    `ProformaGroup` ni una tabla propia: la proforma ES el tramite, visto desde
 *    la facturacion, y su numero es el consecutivo del tramite.
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
  /** Importe del concepto, en dolares. */
  amountUsd: number;
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
  /** Flete cobrado (linea de `CostCategory.Flete`). */
  freightUsd: number;
  /** Permisos y demas conceptos trasladados (`CostCategory.Otros`). */
  othersUsd: number;
  /** Impuestos (`CostCategory.Impuestos`). */
  taxesUsd: number;
  /** Suma de los tres anteriores mas los honorarios propios: el total facturado. */
  totalUsd: number;
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

/** Respuesta del listado de proformas disponibles para descargar en lote. */
export interface ProformaListItem {
  shipmentId: string;
  number: string;
  clientName: string;
  issuedAt: string;
  totalUsd: number;
  electronicInvoiceNumber: string | null;
}
