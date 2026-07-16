/**
 * Esquemas Zod del catalogo de servicios de costo (panel admin, permiso
 * cost_services.manage). Fuente: docs/manuales/flujo.md L1-20.
 *
 * Regla del valor por defecto (coherencia tipo <-> valor):
 *   - Percentage -> defaultValue obligatorio, 0..100.
 *   - Fixed      -> defaultValue obligatorio, >= 0.
 *   - Manual     -> sin defaultValue (se ignora / se guarda null).
 * En crear se valida aqui (todos los campos presentes). En editar, como el PATCH
 * puede traer solo una parte, la coherencia final la resuelve el servicio de la API.
 */
import { z } from 'zod';
import { ServiceValueType } from './cost-service';

/** Aplica la regla de coherencia tipo <-> valor sobre un objeto ya parseado. */
function refineValueCoherence(
  data: { valueType: ServiceValueType; defaultValue?: number | null },
  ctx: z.RefinementCtx,
): void {
  if (data.valueType === ServiceValueType.Manual) return; // el importe se digita luego
  if (data.defaultValue === undefined || data.defaultValue === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultValue'],
      message: 'Indica el valor por defecto para este tipo.',
    });
    return;
  }
  if (data.valueType === ServiceValueType.Percentage && data.defaultValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultValue'],
      message: 'El porcentaje debe estar entre 0 y 100.',
    });
  }
}

/** Crear servicio. Nace habilitado salvo que se indique lo contrario. */
export const createCostServiceSchema = z
  .object({
    name: z.string().trim().min(1, 'El nombre es obligatorio.'),
    valueType: z.nativeEnum(ServiceValueType),
    defaultValue: z.number().nonnegative('El valor no puede ser negativo.').nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine(refineValueCoherence);
export type CreateCostServiceInput = z.infer<typeof createCostServiceSchema>;

/**
 * Editar servicio. Todos los campos opcionales pero al menos uno presente.
 * `valueType` y `defaultValue` van acoplados: si cambia el tipo, envia tambien
 * el valor. La coherencia final la normaliza el servicio de la API.
 */
export const updateCostServiceSchema = z
  .object({
    name: z.string().trim().min(1, 'El nombre es obligatorio.').optional(),
    valueType: z.nativeEnum(ServiceValueType).optional(),
    defaultValue: z.number().nonnegative('El valor no puede ser negativo.').nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No hay cambios que aplicar.' });
export type UpdateCostServiceInput = z.infer<typeof updateCostServiceSchema>;

/** Filtros del listado: busqueda por nombre + tipo + habilitado. */
export const listCostServicesQuerySchema = z.object({
  q: z.string().trim().optional(),
  valueType: z.nativeEnum(ServiceValueType).optional(),
  enabled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});
export type ListCostServicesQuery = z.infer<typeof listCostServicesQuerySchema>;
