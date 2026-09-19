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
import { ShipmentField } from '../shipments/shipment';
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
  /**
   * Campos de datos que admiten edicion MIENTRAS el tramite esta en este estado.
   * Vacio = solo transiciones (el tramite ya no acepta cambios de datos).
   *
   * Dos fronteras del dominio ordenan estas ventanas:
   *   1. Identidad fisica: el tracking/AWB se congela al salir de la prealerta
   *      (Paqueteria: al recibir en bodega) — es la clave de join con el
   *      proveedor y con el indice unico de tracking activo.
   *   2. Congelamiento de factura: al aprobar los costos, todo lo que alimenta el
   *      monto deja de ser editable por PATCH. El candado del PESO no vive aqui
   *      (depende de un dato de la fila, `costsApprovedAt`, no del estado): lo
   *      aplica el servicio. La maquina dice que campos son editables POR estado.
   */
  editable: readonly ShipmentField[];
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

// ---------------------------------------------------------------------------
// Ventanas de edicion por estado (ver Step.editable). Se nombran una vez para no
// repetir listas de campos en cada paso, como LINEAR_ADVANCE con las restrictions.
// ---------------------------------------------------------------------------
const F = ShipmentField;

// Paqueteria. El tracking se congela al recibir; los descriptivos y el PESO siguen
// editables hasta que se aprueban los costos (el peso alimenta la factura); tras el
// congelamiento solo queda el consecutivo de factura electronica (ver FE_ONLY).
// Los valores declarados para el proveedor (comercial, asegurado, arancel, retener)
// se fijan en la prealerta y el staff los corrige hasta la recepcion; despues son
// historicos, como la tienda y el transportista.
const PKG_DECLARED = [F.DeclaredValue, F.InsuredValue, F.TariffPosition, F.Retain];
const PKG_PREALERT = [F.Tracking, F.Description, F.Store, F.Carrier, F.Hawb, F.WeightKg, F.BillingNotes, ...PKG_DECLARED];
const PKG_RECEIVED = [F.Description, F.Store, F.Carrier, F.Hawb, F.WeightKg, F.BillingNotes, ...PKG_DECLARED]; // tracking congelado
const PKG_IN_TRANSIT = [F.Description, F.Hawb, F.WeightKg, F.BillingNotes]; // tienda/transportista ya son historicos
const PKG_BILLING = [F.Description, F.WeightKg, F.BillingNotes, F.ElectronicInvoiceNumber]; // ultimo tramo para el peso (antes de aprobar costos)

// Transporte / Agenciamiento. El AWB/BL se congela al salir de la prealerta; almacen,
// DUA y notas de facturacion se completan durante el proceso; tras aprobar costos solo
// quedan los descriptivos que no tocan la factura.
const TR_PREALERT = [F.Tracking, F.Description, F.Warehouse, F.Dua, F.BillingNotes];
const TR_OPERATIONAL = [F.Description, F.Warehouse, F.Dua, F.BillingNotes]; // tracking congelado
const TR_BILLING = [F.Description, F.BillingNotes, F.ElectronicInvoiceNumber];

/**
 * Agenciamiento DESPUES de facturar. Es el unico flujo que factura a mitad de
 * camino: cobra la proforma y solo entonces entra a aduana. El congelamiento de
 * factura cierra todo lo que alimenta el monto, pero el DUA y el almacen no lo
 * alimentan y el tramite aduanero todavia los esta produciendo (el DUA se
 * numera en aduana, no antes). Cerrarlos aqui obligaria a corregir el estado
 * para anotar un dato que nace mas tarde por definicion.
 */
const AG_CUSTOMS = [F.Warehouse, F.Dua, F.ElectronicInvoiceNumber];

/**
 * Post-factura o entrega: el tramite ya no acepta cambios de datos... salvo UNO.
 *
 * El consecutivo de la factura electronica lo emite un sistema externo DESPUES de
 * que la factura se congela, asi que el unico momento en que se puede escribir es
 * justo cuando todo lo demas ya esta cerrado. Dejarlo fuera obligaria a reversar
 * los costos para anotar un numero que no toca ninguna cifra.
 *
 * Sigue sin haber ventana para nada mas: la lista tiene exactamente un campo.
 */
const FE_ONLY: readonly ShipmentField[] = [F.ElectronicInvoiceNumber];

/** Matriz Flow -> maquina de estados (docs/flujo.md L38-71). */
export const FLOWS: Record<Flow, FlowDef> = {
  // --- Paqueteria (docs/flujo.md L61-71). Notifica al cliente en 3 estados. ---
  [Flow.Paqueteria]: {
    steps: [
      { state: State.Prealertado, permission: Permission.PackageWrite, triggers: [], conditions: [], restrictions: [], editable: PKG_PREALERT },
      { state: State.RecibidoBodegaMiami, permission: Permission.PackageReceive, triggers: [], conditions: [], restrictions: LINEAR_ADVANCE, editable: PKG_RECEIVED },
      { state: State.PreparandoEnvio, permission: Permission.PackageWrite, triggers: [], conditions: [], restrictions: LINEAR_ADVANCE, editable: PKG_IN_TRANSIT },
      { state: State.EnTransitoCostaRica, permission: Permission.PackageWrite, triggers: [], conditions: [], restrictions: LINEAR_ADVANCE, editable: PKG_IN_TRANSIT },
      { state: State.EnAduanas, permission: Permission.PackageWrite, triggers: [Trigger.NotifyStateChange], conditions: [], restrictions: LINEAR_ADVANCE, editable: PKG_IN_TRANSIT },
      { state: State.FacturacionEnProceso, permission: Permission.CostsManage, triggers: [], conditions: [], restrictions: LINEAR_ADVANCE, editable: PKG_BILLING },
      { state: State.EnBodegaPendientePago, permission: Permission.PackageWrite, triggers: [Trigger.NotifyStateChange], conditions: [Condition.RequiresInvoiceAmount], restrictions: LINEAR_ADVANCE, editable: FE_ONLY },
      { state: State.EnRutaEntrega, permission: Permission.DeliveryManage, triggers: [Trigger.NotifyStateChange], conditions: [Condition.RequiresConfirmedPayment], restrictions: LINEAR_ADVANCE, editable: FE_ONLY },
      { state: State.Entregado, permission: Permission.DeliveryManage, triggers: [], conditions: [], restrictions: [Restriction.Terminal], editable: FE_ONLY },
      { state: State.DevueltoBodega, permission: Permission.DeliveryManage, triggers: [], conditions: [Condition.RequiresComment], restrictions: [], editable: FE_ONLY },
    ],
    extra: [
      [State.EnRutaEntrega, State.DevueltoBodega], // entrega fallida -> devuelto
      [State.DevueltoBodega, State.EnRutaEntrega], // reintento de entrega
      /**
       * RECEPCION EN BODEGA (docs/manuales/flujo.md, Parte 4: "mueve el paquete
       * del estado en que se encuentra al estado de Facturación en proceso").
       *
       * Los tramos anteriores los reporta el proveedor por API y llegan con
       * retraso o incompletos; el paquete fisicamente sobre la mesa de bodega es
       * un hecho mas fuerte que el ultimo estado sincronizado. Por eso la
       * recepcion adelanta desde cualquier tramo del proveedor sin pasar por los
       * intermedios: no es saltarse la secuencia, es que la evidencia fisica
       * manda sobre la telemetria.
       */
      [State.RecibidoBodegaMiami, State.FacturacionEnProceso],
      [State.PreparandoEnvio, State.FacturacionEnProceso],
      [State.EnTransitoCostaRica, State.FacturacionEnProceso],
    ],
  },

  /**
   * Transporte: aereo y maritimo. Resumen diario en cada estado activo.
   *
   * SE ENTREGA ANTES DE COBRAR, al reves que Paqueteria: la mercaderia sale en
   * cuanto aduana la libera y el dinero se mueve despues. Por eso no hay estado
   * de bodega ni de ruta (no se reparte con mensajeria, se entrega y ya), y por
   * eso "Facturacion en proceso" hace doble oficio: es donde se aprueban los
   * costos Y donde el cliente paga. El tramite no sale de ahi sin el pago
   * confirmado, que es la guarda de entrada a TramiteFinalizado.
   */
  [Flow.Transporte]: {
    steps: [
      { state: State.Prealertado, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: [], editable: TR_PREALERT },
      { state: State.RecoleccionEnProceso, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_OPERATIONAL },
      { state: State.ProcesoExportacion, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_OPERATIONAL },
      { state: State.EnTransitoDestino, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_OPERATIONAL },
      { state: State.ArriboDestino, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_OPERATIONAL },
      { state: State.ProcesoAduanas, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_OPERATIONAL },
      { state: State.LiberadoAduanas, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_OPERATIONAL },
      { state: State.EntregadoPendientePago, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_OPERATIONAL },
      { state: State.FacturacionEnProceso, permission: Permission.CostsManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_BILLING },
      { state: State.TramiteFinalizado, permission: Permission.PackageWrite, triggers: [], conditions: [Condition.RequiresConfirmedPayment], restrictions: [Restriction.Terminal], editable: FE_ONLY },
    ],
    extra: [],
  },

  /**
   * Agenciamiento: tramite aduanal completo. Resumen diario.
   *
   * SE COBRA ANTES DE ADUANA: la proforma se factura y se cobra, y solo con el
   * pago confirmado el tramite entra a ProcesoAduanas. Por eso el bloque de
   * facturacion vive en mitad del flujo y no al final, y el cierre no pasa por
   * bodega ni por ruta: en Agenciamiento no hay mercaderia que repartir.
   */
  [Flow.Agenciamiento]: {
    steps: [
      { state: State.Prealertado, permission: Permission.PackageWrite, triggers: active(), conditions: [], restrictions: [], editable: TR_PREALERT },
      { state: State.RevisionDocumentos, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_OPERATIONAL },
      { state: State.ExamenPrevio, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_OPERATIONAL },
      { state: State.InspeccionDekra, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_OPERATIONAL },
      { state: State.PreparandoBorradorDua, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_OPERATIONAL },
      { state: State.FacturacionEnProceso, permission: Permission.CostsTramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: TR_BILLING },
      { state: State.ProformaPendientePago, permission: Permission.TramiteManage, triggers: active(), conditions: [Condition.RequiresInvoiceAmount], restrictions: LINEAR_ADVANCE, editable: AG_CUSTOMS },
      { state: State.ProcesoAduanas, permission: Permission.TramiteManage, triggers: active(), conditions: [Condition.RequiresConfirmedPayment], restrictions: LINEAR_ADVANCE, editable: AG_CUSTOMS },
      { state: State.Aforando, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: AG_CUSTOMS },
      { state: State.LiberadoAduanas, permission: Permission.TramiteManage, triggers: active(), conditions: [], restrictions: LINEAR_ADVANCE, editable: AG_CUSTOMS },
      { state: State.TramiteFinalizado, permission: Permission.TramiteManage, triggers: [], conditions: [], restrictions: [Restriction.Terminal], editable: FE_ONLY },
    ],
    extra: [],
  },
};

// ---------------------------------------------------------------------------
// Helpers (derivan todo de FLOWS; ninguna regla se recalcula a mano).
// ---------------------------------------------------------------------------

/**
 * El estado en que se cobra un flow, o undefined si no cobra.
 *
 * No se declara: se DEDUCE de la guarda. El estado cobrable es aquel del que no
 * se puede salir sin el pago confirmado, o sea el que precede en la ruta
 * principal a un estado con `Condition.RequiresConfirmedPayment`. Escribirlo a
 * mano seria un segundo sitio donde decir lo mismo, y el dia que el cobro se
 * mueva de estado (que es justo lo que acaba de pasar en los tres flows) una de
 * las dos copias se quedaria vieja sin que nada lo delate.
 *
 * Hoy da: Paqueteria -> En bodega preparando, Transporte -> Facturacion en
 * proceso (ahi se factura y se cobra, ver la cabecera del flow), Agenciamiento
 * -> Proforma pendiente de pago.
 *
 * Solo mira la ruta principal a proposito. Por una arista `extra` se puede
 * volver a entrar a un estado que exige pago (el reintento de entrega de
 * Paqueteria, Devuelto a bodega -> En ruta), y eso no convierte al origen en un
 * estado de cobro: ese tramite ya pago para salir a ruta la primera vez.
 */
export function payableStateOf(flow: Flow): State | undefined {
  const steps = stepsOf(flow);
  for (const [i, step] of steps.entries()) {
    if (step.restrictions.includes(Restriction.Terminal)) continue;
    const next = steps[i + 1];
    if (next?.conditions.includes(Condition.RequiresConfirmedPayment)) return step.state;
  }
  return undefined;
}

/** True si el tramite se cobra estando en ese estado de ese flow. */
export function isPayable(flow: Flow, state: State): boolean {
  return payableStateOf(flow) === state;
}

/**
 * True si el tramite se puede cobrar AHORA MISMO: esta en su estado de cobro Y
 * ya tiene factura.
 *
 * La segunda mitad no es redundante. En Paqueteria y Agenciamiento al estado de
 * cobro no se entra sin factura (Condition.RequiresInvoiceAmount lo impide), pero
 * en Transporte el estado de cobro es el de facturacion, y ahi se entra ANTES de
 * aprobar los costos: durante ese tramo `isPayable` ya dice que si y todavia no
 * hay nada que pagar. Preguntar solo por el estado hacia que la web ofreciera
 * "Pagar" y la linea de tiempo dijera "pago requerido" sobre una factura que no
 * existia. Todo lo que ofrezca, pida o describa un cobro pregunta aqui.
 */
export function isCollectible(
  flow: Flow,
  data: { state: State; invoiceTotalCrc: number | null },
): boolean {
  return isPayable(flow, data.state) && data.invoiceTotalCrc != null;
}

/**
 * Estados que CIERRAN un tramite, en cualquier flow (Restriction.Terminal).
 *
 * Existe porque el cierre dejo de ser un solo estado: Paqueteria termina en
 * Entregado y los otros dos en Tramite Finalizado. Todo lo que mide "cuando
 * termino" (reportes, el indice de tracking activo) tiene que preguntar por el
 * conjunto y no por un literal, o deja de contar dos flows en silencio.
 */
export function terminalStates(): readonly State[] {
  const out = new Set<State>();
  for (const flow of Object.values(Flow)) {
    for (const step of stepsOf(flow)) {
      if (step.restrictions.includes(Restriction.Terminal)) out.add(step.state);
    }
  }
  return [...out];
}

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

/**
 * Los datos del tramite que responden a las guardas. Se declara como forma
 * minima, no como `ShipmentDto`, para que la API pueda evaluarlas con la fila de
 * la base y la web con el DTO sin que ninguna de las dos dependa de la otra.
 */
export interface GuardData {
  /** Monto de factura en colones; null mientras los costos no esten aprobados. */
  invoiceTotalCrc: number | null;
  /** Si los abonos confirmados cubren ese monto (la respuesta de `isSettled`). */
  settled: boolean;
}

/**
 * Guardas del estado destino que el tramite NO cumple todavia. Vacio = el avance
 * puede ejecutarse ya.
 *
 * Existe para que la UI pueda dejar de ofrecer un avance imposible ANTES de
 * enviarlo: sin esto, "En bodega preparando" ofrecia salir a ruta con la
 * factura sin cobrar y el operador se enteraba por un error del servidor.
 *
 * `RequiresComment` nunca sale aqui, y no es un olvido: no es un dato del
 * tramite sino algo que el usuario escribe en el mismo formulario del avance, asi
 * que evaluarla contra la fila la daria por incumplida siempre. La valida el
 * formulario (y la API con la nota recibida).
 */
export function unmetConditions(
  flow: Flow,
  state: State,
  data: GuardData,
): readonly Condition[] {
  return conditionsFor(flow, state).filter((condition) => {
    switch (condition) {
      case Condition.RequiresInvoiceAmount:
        return data.invoiceTotalCrc == null;
      case Condition.RequiresConfirmedPayment:
        return !data.settled;
      case Condition.RequiresComment:
        return false;
    }
  });
}

/** Restrictions estructurales del estado. */
export function restrictionsOf(flow: Flow, state: State): readonly Restriction[] {
  return stepOf(flow, state)?.restrictions ?? [];
}

/** Permiso RBAC necesario para llevar el tramite a ese estado (undefined si no aplica). */
export function permissionFor(flow: Flow, state: State): Permission | undefined {
  return stepOf(flow, state)?.permission;
}

/**
 * Campos de datos editables con el tramite en `state` (vacio si el estado no
 * pertenece al flow o ya no acepta cambios). Fuente unica para la reja del PATCH
 * en la API y para habilitar/deshabilitar inputs en la web.
 */
export function editableFieldsAt(flow: Flow, state: State): readonly ShipmentField[] {
  return stepOf(flow, state)?.editable ?? [];
}

/** True si `field` admite edicion con el tramite en `state`. */
export function canEditField(flow: Flow, state: State, field: ShipmentField): boolean {
  return editableFieldsAt(flow, state).includes(field);
}
