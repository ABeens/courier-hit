/**
 * Homologacion de estados del proveedor (Helga) a los de HS Global.
 *
 * Fuente: "Estados de Proveedor + preguntas API" (respuesta del proveedor del
 * 2026-07-21 con los 35 estados fijos del sistema) y la tabla de homologacion
 * acordada. Documentado en docs/13-integracion-proveedor-helga.md §3.4.
 *
 * La clave del acuerdo: "En Aduanas" es el estado FINAL del tramo del proveedor y
 * absorbe todo lo que pasa desde que el paquete llega a Costa Rica hasta que
 * aterriza en la bodega de HS Global. De ahi en adelante manda el flujo manual.
 * Por eso `ENTREGADA A DESTINATARIO` mapea a "En Aduanas" y no a "Entregado": en
 * el vocabulario del proveedor el destinatario es HS Global, no el cliente final.
 * Confundir esas dos entregas daria por terminado un paquete que ni siquiera se
 * ha facturado.
 *
 * Tres familias, y solo una avanza el tramite:
 *   - HOMOLOGADOS: representan avance fisico -> mueven el estado.
 *   - OPERATIVOS:  controles, reversiones y correcciones internas del proveedor.
 *     No representan avance: se ignoran (no se muestran al cliente).
 *   - INCIDENCIAS: problemas con el paquete. No encajan en el flujo normal y por
 *     ahora tampoco lo mueven; se marcan para que la operacion los atienda.
 */
import { State } from '../workflow/states';
import { Flow } from '../workflow/shipment-type';

/**
 * Estado del proveedor -> estado de HS Global. Las claves son los valores
 * EXACTOS que devuelve su API, en mayusculas y con tildes tal cual: la
 * normalizacion la hace `mapProviderState`, no una copia distinta de esta tabla.
 */
export const HELGA_STATE_MAP: Record<string, State> = {
  // --- Recibido bodega Miami ---
  // Pre-registro y creacion de guia; el paquete llega fisicamente a la agencia de
  // origen. "_NN" = sin destinatario nominado todavia.
  'SOLICITUD REALIZADA': State.RecibidoBodegaMiami,
  'SOLICITUD CONCILIADA': State.RecibidoBodegaMiami,
  DIGITADO: State.RecibidoBodegaMiami,
  DIGITADO_NN: State.RecibidoBodegaMiami,
  IDENTIFICADO_NN: State.RecibidoBodegaMiami,
  RECIBIDO: State.RecibidoBodegaMiami,
  'EN PLANILLA DE RECOLECCIÓN': State.RecibidoBodegaMiami,

  // --- Preparando para envio ---
  // Agrupacion, consolidacion, manifiesto y generacion de guia aerea.
  AGRUPADA: State.PreparandoEnvio,
  CONSOLIDADA: State.PreparandoEnvio,
  MANIFESTADA: State.PreparandoEnvio,
  'GENERACION DE GUIA TRANSPORTADORA': State.PreparandoEnvio,
  'EN PLANILLA DE DESPACHO': State.PreparandoEnvio,

  // --- En transito a Costa Rica ---
  'ENTREGADA A TRANSPORTADORA': State.EnTransitoCostaRica,
  'LLEGA A AEROPUERTO DESTINO': State.EnTransitoCostaRica,

  // --- En Aduanas (ultimo tramo del proveedor) ---
  // Proceso aduanero + reparto final HASTA la bodega de HS Global.
  'REAJUSTE ADUANERO': State.EnAduanas,
  'DIGITADA EN AGENCIA': State.EnAduanas,
  'EN TRANSITO - PAGO PENDIENTE': State.EnAduanas,
  'EN PLANILLA DE ENTREGA': State.EnAduanas,
  'SALE PARA ENTREGA': State.EnAduanas,
  ENTREGADA: State.EnAduanas,
  'ENTREGADA A DESTINATARIO': State.EnAduanas,
};

/**
 * Estados nuestros que MUEVE el proveedor. Se derivan de la tabla de arriba, no
 * se listan a mano: si manana Helga homologa un estado mas, esta lista lo
 * incluye sola.
 *
 * Es la frontera entre lo automatico y lo manual, y por eso vive en shared: la
 * sincronizacion la usa para saber donde parar, y la web para saber que avances
 * ofrecer. Un paquete no se empuja a mano a "Recibido bodega Miami" porque ese
 * hecho lo reporta el proveedor; si se ofreciera el boton, la operacion estaria
 * adivinando un dato que llega solo.
 */
export const PROVIDER_DRIVEN_STATES: readonly State[] = [
  ...new Set(Object.values(HELGA_STATE_MAP)),
];

/**
 * True si el proveedor es quien lleva el tramite a ese estado.
 *
 * Se pregunta por flow porque el acuerdo con Helga cubre SOLO Paqueteria:
 * Transporte y Agenciamiento no tienen bodega de Miami ni sincronizacion, asi
 * que ninguno de sus estados es del proveedor aunque se llamara igual.
 */
export function isProviderDrivenState(flow: Flow, state: State): boolean {
  return flow === Flow.Paqueteria && PROVIDER_DRIVEN_STATES.includes(state);
}

/**
 * Estados operativos internos del proveedor. No representan avance fisico del
 * paquete —son controles administrativos, reversiones o correcciones— asi que no
 * se homologan ni se exponen al cliente.
 */
export const HELGA_OPERATIONAL_STATES: readonly string[] = [
  'ANULADA',
  'SOLICITUD ANULADA',
  'BLOQUEADO',
  'DESBLOQUEADO',
  'EDITADA',
  'SOLICITUD DESCONCILIADA',
  'SE RETIRA DE PLANILLA DE RECOLECCION',
  'SE RETIRA DEL CONSOLIDADO',
  'SE RETIRA DEL DESPACHO',
  'SE RETIRA DE LA MASTER',
  'SE RETIRA DE PLANILLA DE ENTREGA',
];

/**
 * Estados que señalan un PROBLEMA con el paquete. No encajan en el flujo normal.
 *
 * TODO(13): decidir con HS Global como comunicarlos (un estado generico
 * "Incidencia" o una alerta aparte). Mientras tanto no mueven el tramite, pero
 * `mapProviderState` los distingue de los operativos para que la sincronizacion
 * los pueda registrar y alguien los atienda.
 */
export const HELGA_INCIDENT_STATES: readonly string[] = ['NOVEDAD', 'EN ABANDONO', 'INDEMNIZADO'];

/**
 * Combinaciones `estado` + `estadoAlt` homologadas una por una.
 *
 * Cada evento del historial de Helga trae `estado` (codigo interno) y
 * `estadoAlt` (lo que su pantalla le muestra a la gente). Casi siempre son
 * iguales; cuando no, el `estado` solo no basta para saber donde esta el
 * paquete. Aqui va SOLO lo que HS Global homologo de forma explicita: un
 * `estadoAlt` que no este en esta tabla no mueve nada, aunque su nombre se
 * parezca a uno de los nuestros.
 *
 * Clave: `ESTADO|ESTADOALT`, en mayusculas, como los devuelve su API.
 */
export const HELGA_ALT_STATE_MAP: Record<string, State> = {
  // Visto en vivo el 2026-10-02 (LES48549613): su pantalla lo muestra como
  // "EN ADUANAS".
  'NOVEDAD|EN ADUANAS': State.EnAduanas,
};

/** Que hacer con un estado que llega del proveedor. */
export type ProviderStateMapping =
  | { kind: 'advance'; state: State }
  | { kind: 'operational' }
  | { kind: 'incident'; providerState: string }
  | { kind: 'unknown'; providerState: string };

/**
 * Traduce un estado del proveedor. Punto UNICO de la homologacion: la
 * sincronizacion no interpreta cadenas por su cuenta.
 *
 * Un estado DESCONOCIDO no se ignora en silencio ni se asume inofensivo: se
 * devuelve como tal para que quede registrado. Si el proveedor agrega un estado
 * nuevo, preferimos enterarnos por un aviso a que los paquetes se queden
 * callados en un estado viejo.
 *
 * `alt` es el `estadoAlt` del evento actual, cuando se conoce. Solo cuenta si la
 * pareja esta en `HELGA_ALT_STATE_MAP`, y en ese caso manda sobre el `estado`.
 */
export function mapProviderState(raw: string, alt?: string | null): ProviderStateMapping {
  const key = raw.trim().toUpperCase();

  const altKey = alt?.trim().toUpperCase();
  const byPair = altKey ? HELGA_ALT_STATE_MAP[`${key}|${altKey}`] : undefined;
  if (byPair) return { kind: 'advance', state: byPair };

  const mapped = HELGA_STATE_MAP[key];
  if (mapped) return { kind: 'advance', state: mapped };
  if (HELGA_OPERATIONAL_STATES.includes(key)) return { kind: 'operational' };
  if (HELGA_INCIDENT_STATES.includes(key)) return { kind: 'incident', providerState: key };
  return { kind: 'unknown', providerState: key };
}
