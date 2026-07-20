/**
 * Esquemas Zod de los anuncios (panel admin, permiso announcements.manage).
 * Fuente: docs/manuales/roles.md §3.3.
 *
 * Fechas: el contrato viaja SIEMPRE en UTC (ISO 8601 con Z), segun la regla del
 * repo. El formulario captura hora local y convierte al enviar; la API nunca ve
 * hora local. Por eso los campos se validan como datetime y se normalizan a Date.
 */
import { z } from 'zod';
import {
  ANNOUNCEMENT_MESSAGE_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  AnnouncementStatus,
  AnnouncementType,
} from './announcement';

/** Instante UTC en ISO 8601. Se acepta con o sin milisegundos. */
const instantSchema = z
  .string()
  .datetime({ offset: true, message: 'La fecha debe ser un instante ISO 8601 válido.' })
  .transform((v) => new Date(v));

const titleSchema = z
  .string()
  .trim()
  .min(1, 'El título es obligatorio.')
  .max(ANNOUNCEMENT_TITLE_MAX, `El título no puede pasar de ${ANNOUNCEMENT_TITLE_MAX} caracteres.`);

const messageSchema = z
  .string()
  .trim()
  .min(1, 'El mensaje es obligatorio.')
  .max(ANNOUNCEMENT_MESSAGE_MAX, `El mensaje no puede pasar de ${ANNOUNCEMENT_MESSAGE_MAX} caracteres.`);

/** Una vigencia sin duracion no publica nada: el fin debe ser posterior al inicio. */
function refineRange(
  data: { startsAt?: Date; endsAt?: Date },
  ctx: z.RefinementCtx,
): void {
  if (!data.startsAt || !data.endsAt) return;
  if (data.endsAt.getTime() <= data.startsAt.getTime()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'El fin de la vigencia debe ser posterior al inicio.',
    });
  }
}

/**
 * Crear anuncio. Nace habilitado salvo que se indique lo contrario; si su
 * vigencia arranca en el futuro quedara Programado por derivacion, no por un
 * campo aparte.
 */
export const createAnnouncementSchema = z
  .object({
    title: titleSchema,
    message: messageSchema,
    type: z.nativeEnum(AnnouncementType, {
      errorMap: () => ({ message: 'Elige un tipo de aviso válido.' }),
    }),
    startsAt: instantSchema,
    endsAt: instantSchema,
    enabled: z.boolean().optional(),
  })
  .superRefine(refineRange);
export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;

/**
 * Editar anuncio. Todos los campos opcionales pero al menos uno presente. Si el
 * PATCH toca una sola punta de la vigencia, la coherencia contra la otra la
 * resuelve el servicio de la API (aqui solo hay una de las dos).
 */
export const updateAnnouncementSchema = z
  .object({
    title: titleSchema.optional(),
    message: messageSchema.optional(),
    type: z.nativeEnum(AnnouncementType).optional(),
    startsAt: instantSchema.optional(),
    endsAt: instantSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine(refineRange)
  .refine((o) => Object.keys(o).length > 0, { message: 'No hay cambios que aplicar.' });
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>;

/**
 * Filtros del listado del admin: busqueda por titulo/mensaje + tipo + estado.
 * `status` filtra sobre el estado DERIVADO, asi que la API lo traduce a
 * condiciones de `enabled` + vigencia contra `now()`; no existe tal columna.
 */
export const listAnnouncementsQuerySchema = z.object({
  q: z.string().trim().optional(),
  type: z.nativeEnum(AnnouncementType).optional(),
  status: z.nativeEnum(AnnouncementStatus).optional(),
});
export type ListAnnouncementsQuery = z.infer<typeof listAnnouncementsQuerySchema>;

/** Fila del listado admin: el registro completo + su estado derivado. */
export interface AnnouncementDto {
  id: string;
  title: string;
  message: string;
  type: AnnouncementType;
  /** Instantes UTC en ISO 8601; la vista los convierte a hora local. */
  startsAt: string;
  endsAt: string;
  enabled: boolean;
  status: AnnouncementStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Lo que consume el banner del portal. Deliberadamente mas pobre que
 * `AnnouncementDto`: el cliente no necesita `enabled`, `createdAt` ni el rango
 * de vigencia completo. `endsAt` si viaja, porque el banner agenda su propia
 * desaparicion en ese instante sin esperar al siguiente refresco.
 */
export interface ActiveAnnouncementDto {
  id: string;
  title: string;
  message: string;
  type: AnnouncementType;
  endsAt: string;
}
