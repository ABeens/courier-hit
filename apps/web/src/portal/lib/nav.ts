/**
 * Estado con el que se abre una pantalla cuando se llega a ella DESDE otra.
 *
 * El Resumen no navega "a Costos" sino "a la cola de facturación": llegar a la
 * pantalla y tener que reconstruir a mano el filtro que uno acaba de pulsar
 * convierte un atajo en dos pasos. La cascara (PortalShell) recibe la intencion
 * y la traduce a los props iniciales de cada pantalla.
 *
 * Vive en `lib/` y no en PortalShell para que las pantallas lo importen sin
 * cerrar un ciclo con el modulo que las renderiza.
 */
import type { State } from '@courier/shared';
import type { CostsView } from '../screens/CostsScreen';
import type { ShipmentView } from '../screens/ShipmentsScreen';

export interface NavIntent {
  /** Tablero inicial de los listados de trámites. */
  view?: ShipmentView;
  /** Filtro de estado precargado. */
  state?: State;
  /** Búsqueda precargada (consecutivo, tracking, cliente…). */
  q?: string;
  /** Cola inicial de la pantalla de Costos. */
  costsView?: CostsView;
}
