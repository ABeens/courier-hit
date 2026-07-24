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
 */
export function mapProviderState(raw: string): ProviderStateMapping {
  const key = raw.trim().toUpperCase();

  const mapped = HELGA_STATE_MAP[key];
  if (mapped) return { kind: 'advance', state: mapped };
  if (HELGA_OPERATIONAL_STATES.includes(key)) return { kind: 'operational' };
  if (HELGA_INCIDENT_STATES.includes(key)) return { kind: 'incident', providerState: key };
  return { kind: 'unknown', providerState: key };
}
