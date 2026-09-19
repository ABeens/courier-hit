/**
 * Intento de entrega. Fuente: "Requerimientos Parte 5 - Portal Entregas" y
 * docs/14-modulo-entregas.md.
 *
 * El mensajero no "cambia el estado" del tramite: REGISTRA lo que paso en la
 * puerta del cliente, y el estado es la consecuencia. Por eso la entidad es un
 * intento (append-only, uno por visita) y no un campo en `shipments`: un paquete
 * puede salir a ruta, volver a bodega y salir de nuevo, y el historial de esos
 * intentos es justamente lo que la operacion necesita para reclamar.
 *
 * Dos decisiones que viven aqui:
 *
 * 1. CADA DESENLACE EXIGE SU PRUEBA. Entregado sin foto no es entrega (el manual
 *    lo pide explicito: "Esto implica que suba una foto del paquete entregado");
 *    devuelto sin razon no es devolucion (Condition.RequiresComment del step
 *    Devuelto a bodega). `proofRequirementFor` es el punto unico de esa regla.
 *    La foto es UNA COMO MINIMO y hasta `MAX_DELIVERY_PHOTOS`: en la puerta hace
 *    falta a veces mas de un angulo (la caja, la fachada, quien recibe), y un
 *    reclamo se gana con el conjunto, no con la primera que salio movida.
 * 2. EL DESENLACE MAPEA A UN ESTADO. `stateForOutcome` traduce el intento al
 *    estado destino, y la maquina de estados valida si esa transicion es legal.
 *    Aqui no se decide legalidad, solo equivalencia.
 */
import { State } from '../workflow/states';

/**
 * Cuantas fotos admite un intento. El tope no es un capricho de almacenamiento:
 * el mensajero sube esto de pie y con datos moviles, y pasadas tres fotos la
 * subida empieza a costar mas que la prueba que aporta.
 */
export const MAX_DELIVERY_PHOTOS = 3;

/** Como termino la visita del mensajero. */
export enum DeliveryOutcome {
  Entregado = 'entregado',
  DevueltoBodega = 'devuelto_bodega',
}

export const DELIVERY_OUTCOME_LABELS: Record<DeliveryOutcome, string> = {
  [DeliveryOutcome.Entregado]: 'Entregado',
  [DeliveryOutcome.DevueltoBodega]: 'Devuelto a bodega',
};

/** Estado al que lleva el tramite cada desenlace. */
export function stateForOutcome(outcome: DeliveryOutcome): State {
  return outcome === DeliveryOutcome.Entregado ? State.Entregado : State.DevueltoBodega;
}

/** Prueba obligatoria segun el desenlace. */
export interface ProofRequirement {
  /**
   * La entrega exige foto del paquete entregado: al menos una, hasta
   * `MAX_DELIVERY_PHOTOS`. Es un booleano y no un numero porque la regla es
   * "¿hace falta prueba grafica?"; el tope lo pone la constante, igual para
   * todos los desenlaces que la pidan.
   */
  photo: boolean;
  /** La devolucion exige la razon por escrito. */
  note: boolean;
}

/**
 * Punto UNICO de la regla de prueba. Lo consumen la API (para rechazar) y la web
 * (para habilitar el boton): si divergieran, el mensajero veria un formulario que
 * el servidor no acepta.
 */
export function proofRequirementFor(outcome: DeliveryOutcome): ProofRequirement {
  return outcome === DeliveryOutcome.Entregado
    ? { photo: true, note: false }
    : { photo: false, note: true };
}

/** Intento de entrega tal como lo devuelve la API. */
export interface DeliveryAttemptDto {
  id: string;
  shipmentId: string;
  outcome: DeliveryOutcome;
  /**
   * Claves de las fotos en el almacen de archivos, en el orden en que se
   * subieron. Vacio si el desenlace no llevaba foto; al menos una y como mucho
   * `MAX_DELIVERY_PHOTOS` si `outcome` es Entregado.
   */
  photoFileKeys: string[];
  /** Razon de la devolucion. Obligatoria si `outcome` es DevueltoBodega. */
  note: string | null;
  /** Mensajero que registro el intento. */
  courierName: string | null;
  /** Instante en UTC, ISO 8601. */
  createdAt: string;
}

/** Valores para construir el enum de la BD (Drizzle pgEnum), sin repetirlos. */
export const DELIVERY_OUTCOME_VALUES = Object.values(DeliveryOutcome) as [
  DeliveryOutcome,
  ...DeliveryOutcome[],
];
