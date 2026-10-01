/**
 * Auditoria de correcciones administrativas (solo lectura). Serializa los
 * asientos del historial al contrato `CorrectionDto`: instantes en ISO UTC, la
 * nota sin el prefijo y el tipo reconocido por su texto fijo.
 */
import { CORRECTION_NOTE_PREFIX, correctionKindOf, paged } from '@courier/shared';
import type { CorrectionDto, ListCorrectionsQuery, Page } from '@courier/shared';
import { auditRepo } from './audit.repo';

type Row = Awaited<ReturnType<typeof auditRepo.listCorrections>>['rows'][number];

function toDto(row: Row): CorrectionDto {
  // El filtro del repo garantiza el prefijo; el `?? ''` es solo por tipado.
  const note = row.note ?? '';
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    kind: correctionKindOf(note),
    note: note.startsWith(CORRECTION_NOTE_PREFIX) ? note.slice(CORRECTION_NOTE_PREFIX.length) : note,
    state: row.state,
    previousState: row.previousState,
    shipmentId: row.shipmentId,
    shipmentCode: row.shipmentCode,
    tracking: row.tracking,
    shipmentType: row.shipmentType,
    clientCode: row.clientCode,
    clientName: row.clientName,
    authorName: row.authorName,
  };
}

export const auditService = {
  async listCorrections(query: ListCorrectionsQuery): Promise<Page<CorrectionDto>> {
    const { rows, total } = await auditRepo.listCorrections(query);
    return paged(rows.map(toDto), total, query);
  },
};
