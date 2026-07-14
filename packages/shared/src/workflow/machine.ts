/**
 * Maquina de estados de los tramites: la matriz literal de docs/flujo.md L38-71
 * enriquecida con los tres modificadores por estado (triggers, conditions,
 * restrictions) y el permiso RBAC necesario para avanzar a cada uno.
 *
 * Fuente unica de verdad del proceso: API (validar transiciones, disparar
 * automatizaciones) y web (pintar el timeline, habilitar botones) consumen esto.
 *
 * Modelo:
 *   Step           = un estado dentro de un flow, con sus reglas.
 *   FlowDef.steps  = ruta principal ORDENADA (el "happy path").
 *   FlowDef.extra  = aristas adicionales (ramas y reingresos) fuera de la linea.
 * Las transiciones validas se derivan de (steps consecutivos) + (extra).
 */
import { Permission } from '../auth/permissions';
import { State } from './states';
import { Flow } from './shipment-type';
import {
  Condition,
  LINEAR_ADVANCE,
  Restriction,
  Trigger,
} from './automation';

/** Un estado dentro de un flow, con todas sus reglas. */
export interface Step {
  state: State;
  /** Permiso requerido para llevar el tramite a este estado (Barrera RBAC). */
  permission: Permission;
  /** Automatizaciones que se disparan al ENTRAR al estado. */
  triggers: readonly Trigger[];
  /** Guardas de datos que deben cumplirse para ENTRAR al estado. */
  conditions: readonly Condition[];
  /** Reglas estructurales/de acceso de la transicion. */
  restrictions: readonly Restriction[];
}

/** Definicion completa de una maquina de estados. */
export interface FlowDef {
  /** Ruta principal, en orden. El primero es el estado inicial. */
  steps: readonly Step[];
  /** Aristas fuera de la linea principal: [from, to] (ramas / reingresos). */
  extra: readonly (readonly [State, State])[];
}

// Atajo para no repetir el trigger del resumen diario en Transporte/Agenciamiento.
const active = (t: readonly Trigger[] = []): readonly Trigger[] => [
  Trigger.DailyActiveSummary,
  ...t,
];

/** Matriz Flow -> maquina de estados (docs/flujo.md L38-71). */
export const FLOWS: Record<Flow, FlowDef> = {
  // --- Paqueteria (docs/flujo.md L61-71). Notifica al cliente en 3 estados. ---
  [Flow.Paqueteria]: {
    steps: [
      { state: State.Prealertado, permission: Permission.PackageWrite, triggers: [], conditions: [], restrictions: [] },
      { state: State.RecibidoBodegaMiami, permission: Permission.PackageReceive, triggers: [], conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.PreparandoEnvio, permission: Permission.PackageWrite, triggers: [], conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.EnTransitoCostaRica, permission: Permission.PackageWrite, triggers: [], conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.EnAduanas, permission: Permission.PackageWrite, triggers: [Trigger.NotifyStateChange], conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.FacturacionEnProceso, permission: Permission.CostsManage, triggers: [], conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.EnBodegaPendientePago, permission: Permission.PackageWrite, triggers: [Trigger.NotifyStateChange], conditions: [Condition.RequiresInvoiceAmount], restrictions: LINEAR_ADVANCE },
      { state: State.EnRutaEntrega, permission: Permission.DeliveryManage, triggers: [Trigger.NotifyStateChange], conditions: [Condition.RequiresConfirmedPayment], restrictions: LINEAR_ADVANCE },
      { state: State.Entregado, permission: Permission.DeliveryManage, triggers: [], conditions: [], restrictions: [Restriction.Terminal] },
      { state: State.DevueltoBodega, permission: Permission.DeliveryManage, triggers: [], conditions: [Condition.RequiresComment], restrictions: [] },
    ],
    extra: [
      [State.EnRutaEntrega, State.DevueltoBodega], // entrega fallida -> devuelto
      [State.DevueltoBodega, State.EnRutaEntrega], // reintento de entrega
    ],
  },

  // --- Transporte: aereo y maritimo (docs/flujo.md L38-48). Resumen diario. ---
  [Flow.Transporte]: {
    steps: [
      { state: State.Prealertado, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: [] },
      { state: State.RecoleccionEnProceso, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.ProcesoExportacion, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.EnTransitoDestino, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.ArriboDestino, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.ProcesoAduanas, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.FacturacionEnProceso, permission: Permission.CostsManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.EnBodegaPendientePago, permission: Permission.PackageWrite, triggers: active(), conditions: [Condition.RequiresInvoiceAmount], restrictions: LINEAR_ADVANCE },
      { state: State.EnRutaEntrega, permission: Permission.DeliveryManage, triggers: active(), conditions: [Condition.RequiresConfirmedPayment], restrictions: LINEAR_ADVANCE },
      { state: State.Entregado, permission: Permission.DeliveryManage, triggers: [], conditions: [], restrictions: [Restriction.Terminal] },
    ],
    extra: [],
  },

  // --- Agenciamiento (docs/flujo.md L49-60). Resumen diario. ---
  [Flow.Agenciamiento]: {
    steps: [
      { state: State.Prealertado, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: [] },
      { state: State.RevisionDocumentos, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.ExamenPrevio, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.InspeccionDekra, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.PreparandoBorradorDua, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.PendienteAdelantoImpuestos, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.ProcesoAduanas, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.FacturacionEnProceso, permission: Permission.CostsTramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE },
      { state: State.EnBodegaPendientePago, permission: Permission.TramiteManage, triggers: active(), conditions: [Condition.RequiresInvoiceAmount], restrictions: LINEAR_ADVANCE },
      { state: State.EnRutaEntrega, permission: Permission.DeliveryManage, triggers: active(), conditions: [Condition.RequiresConfirmedPayment], restrictions: LINEAR_ADVANCE },
      { state: State.Entregado, permission: Permission.DeliveryManage, triggers: [], conditions: [], restrictions: [Restriction.Terminal] },
    ],
    extra: [],
  },
};

// ---------------------------------------------------------------------------
// Helpers (derivan todo de FLOWS; ninguna regla se recalcula a mano).
// ---------------------------------------------------------------------------

/** Steps ordenados de un flow. */
export function stepsOf(flow: Flow): readonly Step[] {
  return FLOWS[flow].steps;
}

/** Estados de un flow, en el orden de la ruta principal. */
export function statesOf(flow: Flow): readonly State[] {
  return stepsOf(flow).map((s) => s.state);
}

/** Estado inicial (Prealertado) de un flow. Todo flow tiene >= 1 step. */
export function initialState(flow: Flow): State {
  return stepsOf(flow)[0]!.state;
}

/** El step de un estado dentro de un flow (undefined si no pertenece). */
export function stepOf(flow: Flow, state: State): Step | undefined {
  return stepsOf(flow).find((s) => s.state === state);
}

/** True si el estado no admite avance (Restriction.Terminal). */
export function isTerminal(flow: Flow, state: State): boolean {
  return restrictionsOf(flow, state).includes(Restriction.Terminal);
}

/**
 * Estados a los que se puede transicionar desde `state`: el siguiente de la ruta
 * principal (si no es terminal) mas las aristas `extra` que salgan de el.
 */
export function nextStates(flow: Flow, state: State): readonly State[] {
  const { steps, extra } = FLOWS[flow];
  const targets = new Set<State>();

  const i = steps.findIndex((s) => s.state === state);
  const next = i >= 0 ? steps[i + 1] : undefined;
  if (next && !isTerminal(flow, state)) {
    targets.add(next.state);
  }
  for (const [from, to] of extra) {
    if (from === state) targets.add(to);
  }
  return [...targets];
}

/** True si `to` es un destino valido desde `from` en el flow. */
export function canTransition(flow: Flow, from: State, to: State): boolean {
  return nextStates(flow, from).includes(to);
}

/** Triggers que se disparan al entrar al estado. */
export function triggersOnEnter(flow: Flow, state: State): readonly Trigger[] {
  return stepOf(flow, state)?.triggers ?? [];
}

/** Conditions (guardas de datos) para poder entrar al estado. */
export function conditionsFor(flow: Flow, state: State): readonly Condition[] {
  return stepOf(flow, state)?.conditions ?? [];
}

/** Restrictions estructurales del estado. */
export function restrictionsOf(flow: Flow, state: State): readonly Restriction[] {
  return stepOf(flow, state)?.restrictions ?? [];
}

/** Permiso RBAC necesario para llevar el tramite a ese estado (undefined si no aplica). */
export function permissionFor(flow: Flow, state: State): Permission | undefined {
  return stepOf(flow, state)?.permission;
}
