/**
 * Esquemas Zod del modulo de entregas (permiso delivery.manage).
 *
 * El registro del intento llega como multipart (lleva las fotos, hasta
 * `MAX_DELIVERY_PHOTOS`), asi que estos esquemas validan los CAMPOS DE TEXTO del
 * formulario; los archivos los validan la capa de almacenamiento de la API (tipo
 * y tamaño) y el servicio de entregas (cuantos). Por eso `photoFileKeys` no esta
 * aqui: no las elige el cliente, las devuelve el almacen al guardar cada
 * archivo.
 */
import { z } from 'zod';
import { paginationQuerySchema } from '../http/pagination';
import { DeliveryOutcome } from './delivery';
import { proofRequirementFor } from './delivery';

/**
 * Registro de un intento de entrega. Las fotos se validan en la API (son
 * archivos, no campos); aqui se exige la nota cuando el desenlace es una
 * devolucion, que es la mitad de la regla que SI se puede comprobar sobre el
 * texto.
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
 *
 * Van SIN paginacion y aparte del esquema del listado porque los consumen dos
 * cosas distintas: la cola paginada de la pantalla y la hoja de ruta imprimible,
 * que no tiene paginas porque es un documento. Compartir el filtro es lo que
 * garantiza que el papel diga exactamente lo que el mensajero esta viendo.
 */
export const deliveryQueueFilterSchema = z.object({
  q: z.string().trim().optional(),
  routeNumber: z.coerce
    .number()
    .int('La ruta es un número entero.')
    .positive('La ruta debe ser mayor que cero.')
    .optional(),
});
export type DeliveryQueueFilter = z.infer<typeof deliveryQueueFilterSchema>;

export const listDeliveryQueueQuerySchema = deliveryQueueFilterSchema.merge(paginationQuerySchema);
export type ListDeliveryQueueQuery = z.infer<typeof listDeliveryQueueQuerySchema>;
