/**
 * Tono semantico de un estado de tramite: la familia de color con la que se
 * pinta en la interfaz.
 *
 * Vive fuera de las pantallas porque el MISMO estado tiene que verse igual en
 * todas: la ficha de Paqueteria, los cuadros del Resumen y lo que venga
 * despues. Si cada pantalla eligiera su color, "Devuelto a bodega" seria rojo
 * en una y gris en otra, y el color dejaria de significar algo.
 */
import { State } from '@courier/shared';

export type Tone = 'neutral' | 'info' | 'warn' | 'ok' | 'danger';

/**
 * Tono de cada estado, para que al recorrer una lista se distinga de un vistazo
 * lo que avanza (info) de lo que espera una accion (warn) o ya cerro (ok).
 * El Record es exhaustivo a proposito: agregar un State obliga a decidir su tono.
 */
export const STATE_TONE: Record<State, Tone> = {
  [State.Prealertado]: 'neutral',

  // En curso: el trámite se está moviendo, nadie tiene que hacer nada.
  [State.RecibidoBodegaMiami]: 'info',
  [State.PreparandoEnvio]: 'info',
  [State.EnTransitoCostaRica]: 'info',
  [State.RecoleccionEnProceso]: 'info',
  [State.ProcesoExportacion]: 'info',
  [State.EnTransitoDestino]: 'info',
  [State.ArriboDestino]: 'info',
  [State.RevisionDocumentos]: 'info',
  [State.ExamenPrevio]: 'info',
  [State.InspeccionDekra]: 'info',
  [State.PreparandoBorradorDua]: 'info',
  [State.EnRutaEntrega]: 'info',

  // Retenido o a la espera de alguien: aduana, facturación o pago del cliente.
  [State.EnAduanas]: 'warn',
  [State.ProcesoAduanas]: 'warn',
  [State.FacturacionEnProceso]: 'warn',
  [State.EnBodegaPendientePago]: 'warn',
  [State.PendienteAdelantoImpuestos]: 'warn',

  [State.Entregado]: 'ok',
  [State.DevueltoBodega]: 'danger',
};
