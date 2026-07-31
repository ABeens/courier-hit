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
  client: ShipmentClientRef;
  /** Guia: tracking en Paqueteria, AWB/BL en Transporte y Agenciamiento. */
  tracking: string;
  /** Descripcion / REF. */
  description: string;

  // --- Solo Paqueteria ---
  store: string | null;
  carrier: string | null;
  /** HAWB / HBL, solo digitos. */
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

  // --- Solo Transporte y Agenciamiento ---
  warehouse: string | null;
  /** DUA con formato ###-####-######. */
  dua: string | null;
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

  /** Instantes en UTC, ISO 8601. La hora local se arma en la presentacion. */
  createdAt: string;
  updatedAt: string;
}

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
  BillingNotes = 'billingNotes',
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
