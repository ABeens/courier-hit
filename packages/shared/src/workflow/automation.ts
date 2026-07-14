/**
 * Los tres modificadores que califican a cada estado de un flow:
 *
 *   - Trigger:     efecto AUTOMATICO que se dispara al ENTRAR al estado
 *                  (docs/flujo.md, seccion "AUTOMATIZACIONES", L173-207).
 *   - Condition:   guarda de DATOS que debe cumplirse para poder entrar al
 *                  estado (precondicion; si no se cumple, la transicion falla).
 *   - Restriction: regla ESTRUCTURAL/de acceso de la transicion (terminal,
 *                  secuencia estricta, sin retroceso).
 *
 * El permiso RBAC necesario para avanzar a cada estado NO vive aqui: se declara
 * por estado en `machine.ts` reutilizando `Permission` de ../auth/permissions.
 */

/** Efecto automatico al ENTRAR al estado. */
export enum Trigger {
  /**
   * Correo inmediato al dueño del paquete avisando el cambio de estado.
   * Solo Paqueteria y solo en: En Aduanas, En bodega - Pendiente pago,
   * En ruta de entrega (docs/flujo.md L177).
   */
  NotifyStateChange = 'notify_state_change',
  /**
   * El tramite queda incluido en el resumen diario por correo de tramites
   * activos. Solo Transporte y Agenciamiento (docs/flujo.md L197).
   */
  DailyActiveSummary = 'daily_active_summary',
}

/** Precondicion de datos para poder ENTRAR al estado. */
export enum Condition {
  /** Exige un comentario/razon (Paqueteria -> Devuelto a bodega, L71). */
  RequiresComment = 'requires_comment',
  /** Exige el pago validado antes de salir a entrega (viene de Pendiente pago). */
  RequiresConfirmedPayment = 'requires_confirmed_payment',
  /** Exige que el monto de factura ya este cargado en el tramite. */
  RequiresInvoiceAmount = 'requires_invoice_amount',
}

/** Regla estructural/de acceso de la transicion. */
export enum Restriction {
  /** Estado final: no admite ninguna transicion de avance. */
  Terminal = 'terminal',
  /** Solo se puede avanzar al estado inmediato siguiente (no saltar pasos). */
  StrictSequence = 'strict_sequence',
  /** Una vez alcanzado, no se puede volver a un estado anterior. */
  NoRollback = 'no_rollback',
}

/** Etiquetas de presentacion. */
export const TRIGGER_LABELS: Record<Trigger, string> = {
  [Trigger.NotifyStateChange]: 'Correo inmediato de cambio de estado al cliente',
  [Trigger.DailyActiveSummary]: 'Incluido en el resumen diario de trámites activos',
};

export const CONDITION_LABELS: Record<Condition, string> = {
  [Condition.RequiresComment]: 'Requiere comentario con la razón',
  [Condition.RequiresConfirmedPayment]: 'Requiere el pago confirmado',
  [Condition.RequiresInvoiceAmount]: 'Requiere el monto de factura cargado',
};

export const RESTRICTION_LABELS: Record<Restriction, string> = {
  [Restriction.Terminal]: 'Estado final (sin avance)',
  [Restriction.StrictSequence]: 'Avance solo al siguiente estado',
  [Restriction.NoRollback]: 'No admite retroceso',
};

/** Reglas de avance por defecto de un paso lineal de staff. */
export const LINEAR_ADVANCE: readonly Restriction[] = [
  Restriction.StrictSequence,
  Restriction.NoRollback,
];
