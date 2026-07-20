/**
 * Lectura de casilleros para el panel administrador. La direccion se devuelve
 * como CODIGOS territoriales (provincia/canton/distrito), no como etiquetas: el
 * catalogo vive en @courier/shared y es la web quien lo resuelve a nombres.
 */
import type { ClientReviewStatus } from '@courier/shared';
import { clientsRepo } from './clients.repo';

/** Casillero tal como lo ve el panel administrador. */
export interface ClientListItem {
  id: string;
  /** Codigo de casillero `HS-1042`. */
  code: string;
  name: string;
  email: string;
  phone: string | null;
  idNumber: string;
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
  reviewStatus: ClientReviewStatus;
  /** Nombre de la tarifa asignada; null si quedo sin tarifa. */
  clientRateName: string | null;
  shipmentCount: number;
}

export const clientsService = {
  async list(q?: string): Promise<{ items: ClientListItem[] }> {
    const rows = await clientsRepo.list(q);
    return { items: rows.map(({ createdAt: _createdAt, ...item }) => item) };
  },
};
