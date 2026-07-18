/**
 * Catalogo de servicios de costo (permiso cost_services.manage, solo admin).
 * Reglas (docs/manuales/flujo.md L1-20):
 *   - nombre unico (case-insensitive).
 *   - coherencia tipo de servicio <-> tipo de valor: Transporte y Agenciamiento se
 *     carga al recibir el tramite, asi que solo admite Manual; Paqueteria admite
 *     los tres.
 *   - coherencia tipo <-> valor: Percentage/Fixed exigen valor; Manual lo ignora.
 *   - "deshabilitar, no eliminar": no hay DELETE; se conmuta `enabled`.
 */
import { ServiceKind, ServiceValueType, isValueTypeAllowed } from '@courier/shared';
import type { CreateCostServiceInput, UpdateCostServiceInput } from '@courier/shared';
import { CostServiceErrors } from '../../core/errors';
import { costServicesRepo } from './cost-services.repo';

/** Normaliza el valor por defecto segun el tipo, validando coherencia. */
function resolveDefaultValue(
  kind: ServiceKind,
  valueType: ServiceValueType,
  value: number | null | undefined,
): number | null {
  if (!isValueTypeAllowed(kind, valueType)) throw CostServiceErrors.valueTypeNotAllowed();
  if (valueType === ServiceValueType.Manual) return null; // el importe se digita al cargar
  if (value === null || value === undefined) throw CostServiceErrors.valueRequired();
  if (valueType === ServiceValueType.Percentage && (value < 0 || value > 100)) {
    throw CostServiceErrors.invalidPercentage();
  }
  return value;
}

export const costServicesService = {
  async list(query: Parameters<typeof costServicesRepo.list>[0]) {
    const [items, counts] = await Promise.all([costServicesRepo.list(query), costServicesRepo.counts()]);
    return { items, counts };
  },

  async create(input: CreateCostServiceInput) {
    if (await costServicesRepo.nameTaken(input.name)) throw CostServiceErrors.nameInUse();
    return costServicesRepo.insert({
      name: input.name,
      kind: input.kind,
      valueType: input.valueType,
      defaultValue: resolveDefaultValue(input.kind, input.valueType, input.defaultValue),
      enabled: input.enabled ?? true,
    });
  },

  async update(id: string, patch: UpdateCostServiceInput) {
    const target = await costServicesRepo.findById(id);
    if (!target) throw CostServiceErrors.notFound();

    if (patch.name !== undefined && (await costServicesRepo.nameTaken(patch.name, id))) {
      throw CostServiceErrors.nameInUse();
    }

    // Tipo de servicio, tipo de valor y valor van acoplados: se recomputa la
    // coherencia con el estado final (cambiar solo el kind puede invalidar el tipo).
    const nextKind = patch.kind ?? target.kind;
    const nextType = patch.valueType ?? target.valueType;
    const nextValueRaw = 'defaultValue' in patch ? patch.defaultValue : target.defaultValue;
    const coherenceChanged =
      patch.kind !== undefined || patch.valueType !== undefined || 'defaultValue' in patch;

    const updated = await costServicesRepo.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.valueType !== undefined ? { valueType: patch.valueType } : {}),
      ...(coherenceChanged ? { defaultValue: resolveDefaultValue(nextKind, nextType, nextValueRaw) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
    if (!updated) throw CostServiceErrors.notFound();
    return updated;
  },
};
