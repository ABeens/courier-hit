/**
 * Anuncios manuales (docs/manuales/roles.md §3).
 *
 * Reglas:
 *   - El estado NO se almacena: se deriva de `enabled` + vigencia (§3.3.5). El
 *     servicio se limita a devolverlo calculado para que el admin no tenga que
 *     recalcularlo y no puedan divergir dos implementaciones.
 *   - La vigencia es un rango cerrado: al editar una sola punta se valida contra
 *     la otra tal como quedara en BD, no contra la que venia en el PATCH.
 *   - Borrar SI existe (§3.3.3): un anuncio no deja rastro del que colgar nada.
 */
import { announcementStatus } from '@courier/shared';
import type {
  ActiveAnnouncementDto,
  AnnouncementDto,
  CreateAnnouncementInput,
  ListAnnouncementsQuery,
  UpdateAnnouncementInput,
} from '@courier/shared';
import { AnnouncementErrors } from '../../core/errors';
import { announcementsRepo } from './announcements.repo';

type Row = Awaited<ReturnType<typeof announcementsRepo.findById>> & object;

/** Serializa a la forma del contrato: instantes en ISO UTC + estado derivado. */
function toDto(row: Row, now: Date): AnnouncementDto {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    type: row.type,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    enabled: row.enabled,
    status: announcementStatus(row, now),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const announcementsService = {
  async list(query: ListAnnouncementsQuery) {
    const [rows, counts] = await Promise.all([announcementsRepo.list(query), announcementsRepo.counts()]);
    // Un unico `now` para todo el listado: dos filas iguales no pueden salir con
    // estados distintos por haberse evaluado con milisegundos de diferencia.
    const now = new Date();
    return { items: rows.map((r) => toDto(r, now)), counts };
  },

  async create(input: CreateAnnouncementInput): Promise<AnnouncementDto> {
    const row = await announcementsRepo.insert({
      title: input.title,
      message: input.message,
      type: input.type,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      enabled: input.enabled ?? true,
    });
    return toDto(row, new Date());
  },

  async update(id: string, patch: UpdateAnnouncementInput): Promise<AnnouncementDto> {
    const target = await announcementsRepo.findById(id);
    if (!target) throw AnnouncementErrors.notFound();

    // El rango se valida sobre el estado FINAL: mover solo "Desde" mas alla del
    // "Hasta" guardado dejaria una vigencia vacia que el DTO no puede detectar.
    const nextStartsAt = patch.startsAt ?? target.startsAt;
    const nextEndsAt = patch.endsAt ?? target.endsAt;
    if (nextEndsAt.getTime() <= nextStartsAt.getTime()) throw AnnouncementErrors.invalidRange();

    const updated = await announcementsRepo.update(id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.message !== undefined ? { message: patch.message } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
      ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
    if (!updated) throw AnnouncementErrors.notFound();
    return toDto(updated, new Date());
  },

  async remove(id: string): Promise<void> {
    if (!(await announcementsRepo.remove(id))) throw AnnouncementErrors.notFound();
  },

  /**
   * Lo que publica el portal del cliente. Ya viene filtrado, ordenado y recortado
   * a 3 desde SQL. `nextChangeAt` es el fin de vigencia mas proximo: se lo
   * damos al cliente para que agende su propio refresco justo en ese instante en
   * vez de sondear a ciegas (§3.4.5).
   */
  async listActive(): Promise<{ items: ActiveAnnouncementDto[]; nextChangeAt: string | null }> {
    const [rows, nextExpiry] = await Promise.all([
      announcementsRepo.listLive(),
      announcementsRepo.nextLiveExpiry(),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        message: r.message,
        type: r.type,
        endsAt: r.endsAt.toISOString(),
      })),
      nextChangeAt: nextExpiry?.toISOString() ?? null,
    };
  },
};
