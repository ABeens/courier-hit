/**
 * Esquemas Zod del modulo de entregas (permiso delivery.manage).
 *
 * El registro del intento llega como multipart (lleva la foto), asi que estos
 * esquemas validan los CAMPOS DE TEXTO del formulario; el archivo lo valida la
 * capa de almacenamiento de la API. Por eso `photoFileKey` no esta aqui: no lo
 * elige el cliente, lo devuelve el almacen al guardar el archivo.
 */
import { z } from 'zod';
import { DeliveryOutcome } from './delivery';
import { proofRequirementFor } from './delivery';

/**
 * Registro de un intento de entrega. La foto se valida en la API (es un archivo,
 * no un campo); aqui se exige la nota cuando el desenlace es una devolucion,
 * que es la mitad de la regla que SI se puede comprobar sobre el texto.
 */
export const recordDeliveryAttemptSchema = z
  .object({
    outcome: z.nativeEnum(DeliveryOutcome, {
      errorMap: () => ({ message: 'Indica cómo terminó la entrega.' }),
    }),
    note: z.string().trim().max(500, 'El comentario es demasiado largo.').optional(),
  })
  .superRefine((data, ctx) => {
    if (proofRequirementFor(data.outcome).note && !data.note?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'Indica la razón de la devolución a bodega.',
      });
    }
  });
export type RecordDeliveryAttemptInput = z.infer<typeof recordDeliveryAttemptSchema>;

/**
 * Filtros del dashboard del mensajero (Parte 5: "puede filtrar, por nombre, por
 * ruta y por número de tracking"). `q` cubre nombre y tracking en un solo campo;
 * la ruta va aparte porque es un numero exacto, no una busqueda por texto.
 */
export const listDeliveryQueueQuerySchema = z.object({
  q: z.string().trim().optional(),
  routeNumber: z.coerce
    .number()
    .int('La ruta es un número entero.')
    .positive('La ruta debe ser mayor que cero.')
    .optional(),
});
export type ListDeliveryQueueQuery = z.infer<typeof listDeliveryQueueQuerySchema>;
