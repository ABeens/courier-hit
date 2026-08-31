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
 *   - cada tarifa marca si OCUPA REVISION antes de facturar (OPS-003). Aqui solo
 *     se guarda la marca; quien la lee es `autoBillingService`, al recibir el
 *     paquete en bodega.
 *   - cada tarifa tiene un TIPO (`ClientRateKind`): la Consolidada cobra el peso
 *     real y se salda con un pago agrupado. La tarifa por defecto NO puede ser
 *     consolidada: es a la que caen los casilleros nuevos.
 */
import { ClientRateKind } from '@courier/shared';
import type { ClientRate, CreateClientRateInput, UpdateClientRateInput } from '@courier/shared';
import { ClientRateErrors } from '../../core/errors';
import { tariffsRepo } from './tariffs.repo';
import type { ClientRateRow } from './tariffs.schema';

type RateColumns = Pick<
  ClientRateRow,
  | 'id'
  | 'name'
  | 'kind'
  | 'pricePerKg'
  | 'currency'
  | 'isDefault'
  | 'allowsCard'
  | 'allowsBankDeposit'
  | 'requiresBillingReview'
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
      kind: input.kind ?? ClientRateKind.Estandar,
      pricePerKg: input.pricePerKg,
      currency: input.currency,
      allowsCard: input.allowsCard,
      allowsBankDeposit: input.allowsBankDeposit,
      requiresBillingReview: input.requiresBillingReview ?? false,
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

    /**
     * La default nunca puede ser Consolidada, y hay que mirarlo sobre el ESTADO
     * FINAL: el esquema Zod solo ve el parche, asi que no atrapa ni "vuelve
     * consolidada la que ya es default" ni "promueve a default la que ya es
     * consolidada". Cualquiera de las dos pondria a todo casillero nuevo en cobro
     * agrupado sin que nadie lo haya decidido (ver `assertKindAllowsDefault`).
     */
    const nextKind = patch.kind ?? target.kind;
    const nextDefault = patch.isDefault ?? target.isDefault;
    if (nextKind === ClientRateKind.Consolidada && nextDefault) {
      throw ClientRateErrors.consolidatedCannotBeDefault();
    }

    // Coherencia de medios de pago sobre el estado final (al menos uno habilitado).
    const nextCard = patch.allowsCard ?? target.allowsCard;
    const nextDeposit = patch.allowsBankDeposit ?? target.allowsBankDeposit;
    if (!nextCard && !nextDeposit) throw ClientRateErrors.paymentMethodRequired();

    const updated = await tariffsRepo.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.pricePerKg !== undefined ? { pricePerKg: patch.pricePerKg } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.allowsCard !== undefined ? { allowsCard: patch.allowsCard } : {}),
      ...(patch.allowsBankDeposit !== undefined ? { allowsBankDeposit: patch.allowsBankDeposit } : {}),
      ...(patch.requiresBillingReview !== undefined
        ? { requiresBillingReview: patch.requiresBillingReview }
        : {}),
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
