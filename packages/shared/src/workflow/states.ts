/**
 * Estados posibles de un tramite (union de las 3 maquinas).
 * Fuente autoritativa: docs/flujo.md (L38-71).
 *
 * Un mismo State puede pertenecer a mas de un flow (p. ej. Prealertado,
 * FacturacionEnProceso, EnBodegaPendientePago, EnRutaEntrega, Entregado son
 * comunes). El orden y las reglas de cada estado dependen del flow y viven en
 * `machine.ts`; aqui solo se declara la entidad State y su etiqueta.
 *
 * Las claves (valor del enum) son estables: alimentan el enum de Postgres.
 */

export enum State {
  // --- Comunes a varios flows ---
  Prealertado = 'prealertado',
  FacturacionEnProceso = 'facturacion_en_proceso',
  EnBodegaPendientePago = 'en_bodega_pendiente_pago',
  EnRutaEntrega = 'en_ruta_entrega',
  Entregado = 'entregado',

  // --- Transporte (aereo y maritimo), docs/flujo.md L38-48 ---
  RecoleccionEnProceso = 'recoleccion_en_proceso',
  ProcesoExportacion = 'proceso_exportacion',
  EnTransitoDestino = 'en_transito_destino',
  ArriboDestino = 'arribo_destino',
  ProcesoAduanas = 'proceso_aduanas', // compartido con Agenciamiento

  // --- Agenciamiento, docs/flujo.md L49-60 ---
  RevisionDocumentos = 'revision_documentos',
  ExamenPrevio = 'examen_previo',
  InspeccionDekra = 'inspeccion_dekra',
  PreparandoBorradorDua = 'preparando_borrador_dua',
  PendienteAdelantoImpuestos = 'pendiente_adelanto_impuestos',

  // --- Paqueteria, docs/flujo.md L61-71 ---
  RecibidoBodegaMiami = 'recibido_bodega_miami',
  PreparandoEnvio = 'preparando_envio',
  EnTransitoCostaRica = 'en_transito_costa_rica',
  EnAduanas = 'en_aduanas',
  DevueltoBodega = 'devuelto_bodega', // permite comentario con la razon (L71)
}

/** Etiqueta de presentacion, literal de docs/flujo.md. */
export const STATE_LABELS: Record<State, string> = {
  [State.Prealertado]: 'Prealertado',
  [State.FacturacionEnProceso]: 'Facturación en proceso',
  [State.EnBodegaPendientePago]: 'En bodega - Pendiente pago',
  [State.EnRutaEntrega]: 'En ruta de entrega',
  [State.Entregado]: 'Entregado',

  [State.RecoleccionEnProceso]: 'Recolección en proceso',
  [State.ProcesoExportacion]: 'Proceso de Exportación',
  [State.EnTransitoDestino]: 'En tránsito a destino',
  [State.ArriboDestino]: 'Arribo a destino',
  [State.ProcesoAduanas]: 'Proceso de Aduanas',

  [State.RevisionDocumentos]: 'Revisión Documentos',
  [State.ExamenPrevio]: 'Examen previo',
  [State.InspeccionDekra]: 'Inspección Dekra',
  [State.PreparandoBorradorDua]: 'Preparando Borrador de DUA',
  [State.PendienteAdelantoImpuestos]: 'Pendiente adelanto impuestos',

  [State.RecibidoBodegaMiami]: 'Recibido bodega Miami',
  [State.PreparandoEnvio]: 'Preparando para envío',
  [State.EnTransitoCostaRica]: 'En Tránsito a Costa Rica',
  [State.EnAduanas]: 'En Aduanas',
  [State.DevueltoBodega]: 'Devuelto a bodega',
};

/** Valores para construir el enum de la BD (Drizzle pgEnum), sin repetirlos. */
export const STATE_VALUES = Object.values(State) as [State, ...State[]];
