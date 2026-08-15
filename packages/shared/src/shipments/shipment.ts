/**
 * Entidad Tramite (Shipment): la unidad central de la operacion. Un tramite es
 * un paquete de Paqueteria comprado en USA, un transporte aereo/maritimo o un
 * agenciamiento aduanal. Fuente: docs/manuales/flujo.md L30-145.
 *
 * El TIPO (`ShipmentType`) lo elige quien lo crea; el FLOW (maquina de estados)
 * se deriva de el con `flowForType` y NO se persiste: derivarlo evita que tipo y
 * flow se desincronicen. Los estados y sus transiciones viven en `workflow/`.
 *
 * Convencion del repo: nombres de codigo en ingles; etiquetas y valores de enum
 * de dominio en espanol. Ver CLAUDE.md.
 */
import type { State } from '../workflow/states';
import { Flow, ShipmentType, flowForType } from '../workflow/shipment-type';

/**
 * Cliente al que pertenece el tramite, en la forma reducida que necesitan los
 * dashboards (no se expone el perfil completo del casillero).
 */
export interface ShipmentClientRef {
  id: string;
  /** Codigo de casillero, `HS-1000`. */
  code: string;
  name: string;
}

/** Tramite tal como lo devuelve la API. */
export interface ShipmentDto {
  id: string;
  /** Consecutivo de negocio `HSX000001000` (ver `formatShipmentCode`). */
  code: string;
  shipmentType: ShipmentType;
  /** Derivado de `shipmentType`; viaja en la respuesta para no recalcularlo en la UI. */
  flow: Flow;
  state: State;
  /**
   * Titular del tramite, o `null` cuando el paquete llego a bodega sin dueño
   * conocido y todavia espera en la sala de control (`isUnassigned`).
   *
   * Un tramite sin dueño es un callejon sin salida a proposito: no avanza de
   * estado, no se cotiza, no se cobra y no se entrega, porque las cuatro cosas
   * necesitan saber a quien. Lo unico que se puede hacer con el es corregirlo,
   * asignarlo o descartarlo. Por eso el resto del sistema NO lo ve: las consultas
   * del panel, las entregas, los reportes y las notificaciones cruzan contra el
   * casillero y una fila sin casillero se queda fuera sola.
   */
  client: ShipmentClientRef | null;
  /** Guia: tracking en Paqueteria, AWB/BL en Transporte y Agenciamiento. */
  tracking: string;
  /** Descripcion / REF. */
  description: string;

  // --- Solo Paqueteria ---
  store: string | null;
  carrier: string | null;
  /** HAWB (LES): el identificador del paquete en la bodega de Miami, solo digitos. */
  hawb: string | null;
  /** Peso en kilos, entero (siempre redondeado hacia arriba al guardar). */
  weightKg: number | null;
  /**
   * Medidas que reporta el operador de Miami: centimetros y peso volumetrico en
   * kilos. Solo INFORMATIVAS, no entran en la factura (que se calcula con
   * `weightKg`). Nulas mientras el proveedor no las haya reportado; llegan con la
   * sincronizacion, no las digita nadie.
   */
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  volumetricWeightKg: number | null;
  /**
   * Valor comercial declarado, en USD (moneda explicita en el nombre, regla M2).
   * Lo captura el cliente en la prealerta y alimenta `valor_comercial` de la
   * prealerta del proveedor. No es un monto transaccional: no lleva tasa de
   * cambio (M5 no aplica), como el limite de credito o el total de factura.
   */
  declaredValueUsd: number | null;
  /** Valor asegurado, en USD. Solo lo fija el staff; null = no indicado (el proveedor asume 0). */
  insuredValueUsd: number | null;
  /** Posicion arancelaria del contenido. Solo staff; null = no se conoce (se omite ante el proveedor). */
  tariffPosition: string | null;
  /** Retener el paquete en la bodega del proveedor. Solo staff; null/false = no retener. */
  retain: boolean | null;

  /**
   * Clave del documento adjunto (la factura de la compra, tipicamente), o null
   * si no se adjunto ninguno. Es OPACA: no sirve para construir una URL ni
   * revela el nombre del archivo original. La UI solo la mira para saber si hay
   * algo que descargar; el contenido se pide a
   * `GET /api/shipments/:id/document`, que es quien comprueba el permiso.
   */
  documentFileKey: string | null;

  // --- Solo Transporte y Agenciamiento ---
  warehouse: string | null;
  /** DUA con formato ###-####-######. */
  dua: string | null;

  /**
   * Notas para facturar. COMUN a los dos flujos: el reporte las pide igual en
   * Paqueteria (campo 20) que en Agenciamiento (campo 19). Nacio como campo de
   * Transporte porque asi lo listaba el manual.
   */
  billingNotes: string | null;

  /**
   * Ruta operativa del distrito de entrega del cliente. Se resuelve al leer
   * (join con las rutas por distrito) en vez de copiarse al tramite: si el
   * administrador reasigna la ruta de un distrito, los tramites en curso la
   * reflejan sin migrar datos.
   */
  routeNumber: number | null;

  /**
   * Monto de factura, congelado al APROBAR los costos. Va en las DOS monedas
   * (regla M2: ninguna cifra sin moneda) porque asi lo pide el dashboard
   * ("Monto de Factura ($ y ₡)", docs/manuales/flujo.md L104). Null mientras los
   * costos no se hayan aprobado.
   */
  invoiceTotalUsd: number | null;
  invoiceTotalCrc: number | null;

  /**
   * Consecutivo de la FACTURA ELECTRONICA del tramite (campo FE del reporte:
   * numero 27 en Paqueteria, 23 en Agenciamiento).
   *
   * Lo emite el sistema de facturacion electronica, no nosotros: aqui solo se
   * GUARDA el consecutivo para poder cruzar nuestro tramite con esa factura. Por
   * eso es texto libre y no una secuencia propia, y por eso llega a mano.
   *
   * Va en el tramite y no en una tabla aparte porque la regla del negocio es una
   * factura por tramite (las proformas no se agrupan). Null mientras no se haya
   * emitido, que es el caso de todo tramite antes de facturarse.
   */
  electronicInvoiceNumber: string | null;

  /**
   * Estado del COBRO, derivado en cada lectura de los pagos confirmados del
   * tramite. No existe una columna `pagado` en la tabla: la decision 3 de
   * `payments/payment.ts` es justamente que "pagado" no se guarda, para que no
   * pueda quedar desfasada respecto de los abonos reales (un pago rechazado
   * despues de confirmarse, una linea de costo reabierta, un deposito validado
   * a mano). Se paga el precio de calcularlo al leer a cambio de que no mienta.
   *
   * `settledCrc` es la suma de los abonos CONFIRMADOS reexpresada en colones,
   * cada uno con SU propia tasa (regla M5). `settled` es si esa suma cubre
   * `invoiceTotalCrc`: la misma respuesta que da `isSettled` y que exige
   * Condition.RequiresConfirmedPayment para sacar el paquete a ruta.
   *
   * Sin factura aprobada: 0 y false. No hay nada que cubrir todavia.
   */
  settledCrc: number;
  settled: boolean;
  /**
   * Abonos EN VALIDACION, en colones: comprobantes que el cliente ya subio y que
   * el staff todavia no resolvio. No cuentan como pagados y no entran en
   * `settled`, pero sin este dato la pantalla no puede distinguir "no ha pagado"
   * de "pago y lo estamos revisando", que para el cliente son cosas muy
   * distintas: la primera lo lleva a pagar otra vez.
   */
  pendingCrc: number;
  /**
   * Los MISMOS dos importes reexpresados en dolares, cada abono con SU propia
   * tasa (regla M5), igual que sus hermanos en colones.
   *
   * No son un lujo del formato: al cliente el cobro de Paqueteria se le expresa
   * en dolares y sin convertir a colones (`billingCurrencyFor`), asi que la
   * pantalla necesita el par completo. Se calculan aqui y no en la web porque la
   * tasa de cada abono no viaja en este DTO, y reexpresar con la tasa de hoy
   * daria una cifra distinta a la del servidor.
   *
   * `settled` NO tiene gemelo en dolares a proposito: si el tramite esta cubierto
   * se decide en colones y en un unico sitio (`isSettled`).
   */
  settledUsd: number;
  pendingUsd: number;

  /**
   * Descarte de un paquete sin dueño: el instante en que un administrador decidio
   * que ese bulto no da para mas (llego destrozado, era basura de relleno, se
   * devolvio al operador de Miami). Null en todo tramite vivo.
   *
   * Es un ARCHIVADO, no un DELETE. La fila se queda porque documenta que ese
   * paquete estuvo fisicamente en la bodega, que es justo lo que alguien va a
   * preguntar dentro de seis meses; lo que desaparece es de las pantallas. Solo
   * se puede descartar mientras el paquete no tiene dueño: en cuanto se le asigna
   * uno pasa a ser un tramite normal, y esos se enmiendan por el flujo (corregir
   * estado, reversar costos), no borrandolos.
   */
  discardedAt: string | null;
  /** Motivo del descarte, obligatorio al descartar. Null si el tramite esta vivo. */
  discardReason: string | null;

  /** Instantes en UTC, ISO 8601. La hora local se arma en la presentacion. */
  createdAt: string;
  updatedAt: string;
}

/** Etiqueta con la que la UI nombra un tramite todavia sin dueño. */
export const UNASSIGNED_CLIENT_LABEL = 'Sin asignar';

/**
 * Nombre del titular tal como se muestra, o la etiqueta de "sin dueño".
 *
 * Vive aqui y no en cada pantalla porque el hueco se pinta en siete sitios
 * distintos (tablero, costos, recepcion, avanzar, corregir…) y cada uno
 * inventandose su texto acabaria diciendo "—", "N/D" y "Sin cliente" para la
 * misma cosa.
 */
export function clientName(client: ShipmentClientRef | null): string {
  return client?.name ?? UNASSIGNED_CLIENT_LABEL;
}

/** `HS-1000 — Ana Pérez`, o la etiqueta de "sin dueño" cuando no hay titular. */
export function clientFullLabel(client: ShipmentClientRef | null): string {
  return client ? `${client.code} — ${client.name}` : UNASSIGNED_CLIENT_LABEL;
}

/** True si el paquete llego a bodega sin dueño conocido y sigue esperando uno. */
export function isUnassigned(shipment: Pick<ShipmentDto, 'client'>): boolean {
  return shipment.client === null;
}

/** True si el paquete fue descartado desde la sala de control. */
export function isDiscarded(shipment: Pick<ShipmentDto, 'discardedAt'>): boolean {
  return shipment.discardedAt !== null;
}

/**
 * Guia del tramite tal como se muestra, o `null` cuando no se conoce ninguna.
 *
 * Un paquete que aparece en bodega sin etiqueta legible no tiene tracking, pero
 * la columna es obligatoria (es la llave contra el proveedor y contra el indice
 * de duplicados). En vez de aflojar esa regla por un caso excepcional, el alta
 * sin guia SIEMBRA el consecutivo como tracking: es unico por construccion y no
 * se puede confundir con la guia de una tienda. Aqui se deshace esa siembra para
 * que la pantalla muestre el hueco en vez de un numero que nadie puede rastrear.
 */
export function knownTracking(shipment: Pick<ShipmentDto, 'code' | 'tracking'>): string | null {
  return shipment.tracking === shipment.code ? null : shipment.tracking;
}

/**
 * Un asiento del historial de estados (tabla append-only `shipment_events`): el
 * tramite entro a `state` en `createdAt`. La trazabilidad del tramite es la lista
 * completa de estos asientos, en orden.
 *
 * No lleva el estado ANTERIOR a proposito: se lee del asiento previo. Guardarlo
 * seria un dato derivado que puede contradecir a su vecino.
 */
export interface ShipmentEventDto {
  id: string;
  state: State;
  /**
   * Comentario del asiento, o null si no lleva. Obligatorio al devolver a bodega
   * (Condition.RequiresComment); opcional en el resto de avances, donde suele ser
   * una nota interna de la operacion.
   */
  note: string | null;
  /**
   * Quien lo registro. Null = lo movio el sistema (la sincronizacion con el
   * proveedor), o la respuesta va dirigida al titular del casillero, que no ve
   * nombres de la operacion (ver `shipmentsService.events`).
   */
  createdByName: string | null;
  /** Instante en UTC, ISO 8601. La hora local se arma en la presentacion. */
  createdAt: string;
}

export interface ShipmentEventsResponse {
  items: ShipmentEventDto[];
}

/**
 * Marca con la que una correccion administrativa se distingue de un avance real
 * en el historial (la escribe `transitionsService.correct`). Vive aqui, y no como
 * literal en cada sitio, porque ya la leen dos capas: quien la escribe y quien
 * decide que notas puede ver el cliente.
 *
 * Es una convencion sobre el texto, no una columna: el historial es append-only y
 * no se quiso migrar la tabla por una distincion que hasta ahora solo se leia a
 * ojo. Si algun dia hace falta filtrar correcciones en SQL, ahi si toca columna.
 */
export const CORRECTION_NOTE_PREFIX = 'Corrección: ';

/** True si el tipo usa los campos propios de Paqueteria (tienda, transportista, HAWB, peso). */
export function usesPackageFields(type: ShipmentType): boolean {
  return flowForType(type) === Flow.Paqueteria;
}

/**
 * Campos de datos editables de un tramite. Nombres de codigo en ingles (no son
 * dominio): coinciden 1:1 con las claves de `UpdateShipmentInput` y con las
 * columnas de la tabla. La maquina de estados declara, POR estado, cuales admiten
 * edicion (`Step.editable`); este enum es el vocabulario de esa regla, para que
 * API y web la consuman de un solo lugar en vez de duplicar la lista de campos.
 */
export enum ShipmentField {
  Tracking = 'tracking',
  Description = 'description',
  /**
   * Notas para facturar. Comun a los DOS flujos: el reporte de Paqueteria las
   * pide igual que el de Agenciamiento (campo 20 en ambos). Nacio como campo de
   * Transporte y Agenciamiento porque asi lo listaba el manual, pero facturar un
   * paquete necesita las mismas anotaciones que facturar un tramite.
   */
  BillingNotes = 'billingNotes',
  /**
   * Consecutivo de la factura electronica. Comun a los dos flujos y editable
   * DESPUES de facturar, cuando el resto del tramite ya esta congelado: el
   * numero no existe hasta que la factura se emite.
   */
  ElectronicInvoiceNumber = 'electronicInvoiceNumber',
  // Solo Paqueteria
  Store = 'store',
  Carrier = 'carrier',
  Hawb = 'hawb',
  WeightKg = 'weightKg',
  /** Valor comercial declarado (USD): lo llena el cliente en la prealerta. */
  DeclaredValue = 'declaredValueUsd',
  /** Valor asegurado (USD): solo staff. */
  InsuredValue = 'insuredValueUsd',
  /** Posicion arancelaria: solo staff. */
  TariffPosition = 'tariffPosition',
  /** Retener en bodega del proveedor: solo staff. */
  Retain = 'retain',
  // Solo Transporte y Agenciamiento
  Warehouse = 'warehouse',
  Dua = 'dua',
}

/** Tipos de tramite que el administrador captura y mueve a mano (todo menos Paqueteria). */
export const MANUAL_SHIPMENT_TYPES: readonly ShipmentType[] = [
  ShipmentType.Aereo,
  ShipmentType.MaritimoFCL,
  ShipmentType.MaritimoLCL,
  ShipmentType.Agenciamiento,
];

/**
 * Peso facturable en kilos. El manual es explicito: "a la hora de salvar siempre
 * redondea hacia arriba. Ej: 1.1 => 2" (docs/manuales/flujo.md L115). Punto UNICO
 * de redondeo del peso: nadie mas debe llamar a Math.ceil sobre un peso.
 */
export function roundWeightKg(weight: number): number {
  return Math.ceil(weight);
}

/**
 * Formato del consecutivo de negocio: `HSX` + 9 digitos (ejemplo HSX000001000).
 * El numero sale de una secuencia de Postgres; aqui vive el formato para que API
 * y web lo interpreten igual.
 *
 * La `X` distingue el tramite del casillero, que usa el mismo prefijo `HS` y la
 * misma numeracion arrancando en 1000 (`formatLockerCode`). Sin ella,
 * `HS0001000` y `HS000001000` solo se diferencian por el ancho del relleno, que
 * es justo la clase de detalle que nadie mira al leer un codigo en voz alta o al
 * pegarlo en el buscador. El manual usaba `HS` para el tramite
 * (docs/manuales/flujo.md L92); esto lo corrige a peticion del negocio.
 */
export function formatShipmentCode(sequence: number | string): string {
  return `HSX${String(sequence).padStart(9, '0')}`;
}
