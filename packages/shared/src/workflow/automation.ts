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
   * El tramite aparece en el CORREO DIARIO del cliente como tramite en curso.
   * Solo Transporte y Agenciamiento (docs/flujo.md L197).
   *
   * Aqui habia ademas un correo INMEDIATO por cambio de estado en Paqueteria. Se
   * retiro con el modulo de proformas (decision P16): todos los cambios se
   * avisan en un solo correo diario, que lee el historial de estados.
   */
  DailyActiveSummary = 'daily_active_summary',
  /**
   * Paqueteria: tener un paquete en este estado hace que el cliente reciba el
   * CORREO DIARIO de paquetes ("Reporte de estatus paquetes"), con todos sus
   * paquetes en proceso y el estado de cada uno. Solo Recibido en Miami, En
   * Aduanas y En ruta de entrega: los estados en que antes salia un correo
   * inmediato, que se reemplaza por este resumen de las 6 a. m.
   */
  DailyPackageReport = 'daily_package_report',
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
  [Trigger.DailyActiveSummary]: 'Aparece en el correo diario como trámite en curso',
  [Trigger.DailyPackageReport]: 'El cliente recibe el correo diario de sus paquetes',
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
