/**
 * Tarifas preferenciales de cliente (permiso tariffs.manage, solo admin).
 * Reglas (requisito "Administracion de Tarifas de Paquetes"):
 *   - nombre unico (case-insensitive).
 *   - siempre existe UNA tarifa por defecto: la primera que se crea lo es por
 *     fuerza; promover otra desmarca la anterior; no se puede desmarcar la default
 *     directamente (hay que promover otra).
 *   - la tarifa por defecto no se puede eliminar.
 *   - al eliminar una tarifa, sus casilleros pasan a la tarifa por defecto.
 *   - cada tarifa admite al menos un medio de pago (tarjeta y/o deposito).
 */
import type { ClientRate, CreateClientRateInput, UpdateClientRateInput } from '@courier/shared';
import { ClientRateErrors } from '../../core/errors';
import { tariffsRepo } from './tariffs.repo';
import type { ClientRateRow } from './tariffs.schema';

type RateColumns = Pick<
  ClientRateRow,
  'id' | 'name' | 'pricePerKg' | 'currency' | 'isDefault' | 'allowsCard' | 'allowsBankDeposit'
>;

/** Adjunta el conteo de casilleros a una fila (para el aviso al eliminar). */
async function withClientCount(row: RateColumns): Promise<ClientRate> {
  return { ...row, clientCount: await tariffsRepo.countClientsByRate(row.id) };
}

export const tariffsService = {
  async list(): Promise<{ items: ClientRate[] }> {
    const rows = await tariffsRepo.list();
    const items = await Promise.all(rows.map(withClientCount));
    return { items };
  },

  async create(input: CreateClientRateInput): Promise<ClientRate> {
    if (await tariffsRepo.nameTaken(input.name)) throw ClientRateErrors.nameInUse();

    // La primera tarifa del sistema es, por fuerza, la por defecto.
    const isFirst = (await tariffsRepo.count()) === 0;
    const created = await tariffsRepo.insert({
      name: input.name,
      pricePerKg: input.pricePerKg,
      currency: input.currency,
      allowsCard: input.allowsCard,
      allowsBankDeposit: input.allowsBankDeposit,
      isDefault: isFirst || (input.isDefault ?? false),
    });
    return withClientCount(created);
  },

  async update(id: string, patch: UpdateClientRateInput): Promise<ClientRate> {
    const target = await tariffsRepo.findById(id);
    if (!target) throw ClientRateErrors.notFound();

    if (patch.name !== undefined && (await tariffsRepo.nameTaken(patch.name, id))) {
      throw ClientRateErrors.nameInUse();
    }

    // No se puede quitar el "por defecto" a la tarifa default: hay que promover otra.
    if (target.isDefault && patch.isDefault === false) throw ClientRateErrors.defaultRequired();

    // Coherencia de medios de pago sobre el estado final (al menos uno habilitado).
    const nextCard = patch.allowsCard ?? target.allowsCard;
    const nextDeposit = patch.allowsBankDeposit ?? target.allowsBankDeposit;
    if (!nextCard && !nextDeposit) throw ClientRateErrors.paymentMethodRequired();

    const updated = await tariffsRepo.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.pricePerKg !== undefined ? { pricePerKg: patch.pricePerKg } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.allowsCard !== undefined ? { allowsCard: patch.allowsCard } : {}),
      ...(patch.allowsBankDeposit !== undefined ? { allowsBankDeposit: patch.allowsBankDeposit } : {}),
      ...(patch.isDefault ? { isDefault: true } : {}),
    });
    if (!updated) throw ClientRateErrors.notFound();
    return withClientCount(updated);
  },

  /**
   * Elimina una tarifa reasignando sus casilleros a la por defecto. La default no
   * se puede eliminar. Devuelve cuantos casilleros fueron reasignados.
   */
  async remove(id: string): Promise<{ reassigned: number }> {
    const target = await tariffsRepo.findById(id);
    if (!target) throw ClientRateErrors.notFound();
    if (target.isDefault) throw ClientRateErrors.defaultLocked();

    const fallback = await tariffsRepo.findDefault();
    if (!fallback) throw ClientRateErrors.defaultRequired(); // no deberia pasar (siempre hay default)

    const reassigned = await tariffsRepo.countClientsByRate(id);
    await tariffsRepo.deleteAndReassign(id, fallback.id);
    return { reassigned };
  },
};
