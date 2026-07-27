/**
 * Enlace de un casillero con el proveedor (Helga): contrato compartido entre la
 * API y el panel de administracion.
 *
 * Un casillero que el proveedor no acepta deja al cliente FUERA del portal (con
 * la integracion encendida, el login exige `synced`), asi que el panel necesita
 * ver esos casos, entender por que fallaron y poder corregirlos a mano. Ese es
 * todo el proposito de este modulo.
 */
import { z } from 'zod';
import { HelgaSyncStatus } from '../auth/user';

/** Que origino un evento del enlace. */
export enum ProviderLinkSource {
  /** Alta del casillero (autoregistro del cliente). */
  Registro = 'registro',
  /** Reintento automatico del robot. */
  Reconciliacion = 'reconciliacion',
  /** Correccion manual desde el panel. */
  Manual = 'manual',
}

export const PROVIDER_LINK_SOURCE_VALUES = Object.values(ProviderLinkSource) as [
  ProviderLinkSource,
  ...ProviderLinkSource[],
];

/** Etiqueta visible del origen. */
export const PROVIDER_LINK_SOURCE_LABELS: Record<ProviderLinkSource, string> = {
  [ProviderLinkSource.Registro]: 'Registro',
  [ProviderLinkSource.Reconciliacion]: 'Reintento automático',
  [ProviderLinkSource.Manual]: 'Corrección manual',
};

/** Etiqueta visible del estado del enlace. */
export const HELGA_SYNC_STATUS_LABELS: Record<HelgaSyncStatus, string> = {
  [HelgaSyncStatus.Pending]: 'Pendiente',
  [HelgaSyncStatus.Synced]: 'Enlazado',
  [HelgaSyncStatus.Failed]: 'Rechazado',
};

/** Fila del listado de enlaces del panel. */
export interface ProviderLinkDto {
  clientId: string;
  clientCode: string;
  name: string;
  email: string;
  idNumber: string;
  status: HelgaSyncStatus;
  /** Id del destinatario en Helga; null mientras no haya enlace. */
  helgaClientId: string | null;
  /** Sub-casillero que asigna Helga: la direccion real con la que recibe. */
  subLocker: string | null;
  attempts: number;
  lastError: string | null;
  /** Instantes en UTC (ISO 8601); la web los muestra en hora local. */
  syncedAt: string | null;
  createdAt: string;
  /**
   * True si el cliente NO puede entrar al portal por culpa del enlace. Se calcula
   * en el servidor porque depende de si la integracion esta encendida, algo que
   * la web no sabe: sin esto el panel mostraria "rechazado" sin poder decir si eso
   * tiene consecuencias hoy.
   */
  blocksLogin: boolean;
}

/** Un evento de la bitacora del enlace. */
export interface ProviderLinkEventDto {
  id: string;
  source: ProviderLinkSource;
  status: HelgaSyncStatus;
  detail: string | null;
  changes: Record<string, { from: string | null; to: string | null }> | null;
  createdByName: string | null;
  createdAt: string;
}

/** Detalle de un enlace: la fila mas su bitacora completa. */
export interface ProviderLinkDetailDto {
  link: ProviderLinkDto;
  events: ProviderLinkEventDto[];
}

/** Filtro del listado. Por defecto el panel mira los casos con problema. */
export const listProviderLinksSchema = z.object({
  /** Ausente = solo los que NO estan enlazados (pending + failed), que es el caso de uso. */
  status: z.nativeEnum(HelgaSyncStatus).optional(),
  q: z.string().trim().min(1).max(80).optional(),
});
export type ListProviderLinksQuery = z.infer<typeof listProviderLinksSchema>;

/**
 * Id del destinatario en Helga. Su API los emite como enteros; se guardan como
 * texto (la columna es `text`), asi que se valida la FORMA sin convertir.
 */
const helgaClientIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}$/, 'El id de Helga son solo dígitos.');

/**
 * Sub-casillero del proveedor, con la forma `SJO008835S033`: el codigo del
 * casillero maestro seguido de `S` y el consecutivo del destinatario. Se valida
 * el patron porque escribirlo mal aqui manda los paquetes del cliente a una
 * direccion que el operador de Miami no puede atribuir, y el error solo se
 * descubre cuando el paquete ya se perdio.
 */
const subLockerSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}\d{6,7}S\d{1,4}$/i, 'El sub-casillero tiene la forma SJO008835S033.');

/**
 * Correccion manual del enlace. Todos los campos son opcionales pero el cuerpo no
 * puede venir vacio: un PATCH sin cambios solo ensuciaria la bitacora.
 *
 * `null` limpia el campo (p. ej. borrar un id mal copiado); ausente lo deja igual.
 * La distincion importa: sin ella no habria forma de deshacer una correccion.
 */
export const updateProviderLinkSchema = z
  .object({
    status: z.nativeEnum(HelgaSyncStatus).optional(),
    helgaClientId: helgaClientIdSchema.nullable().optional(),
    subLocker: subLockerSchema.nullable().optional(),
    /** Por que se corrigio a mano. Obligatoria: una bitacora sin motivo no sirve. */
    note: z.string().trim().min(3, 'Explica el motivo de la corrección.').max(300),
  })
  .refine(
    (v) => v.status !== undefined || v.helgaClientId !== undefined || v.subLocker !== undefined,
    { message: 'No hay nada que actualizar.' },
  )
  .refine((v) => v.status !== HelgaSyncStatus.Synced || v.helgaClientId !== null, {
    path: ['helgaClientId'],
    // Marcar 'synced' sin destinatario dejaria pasar el login de un cliente cuyos
    // paquetes el proveedor no puede atribuir: el peor de los dos mundos.
    message: 'No se puede marcar como enlazado sin el id de Helga.',
  });
export type UpdateProviderLinkInput = z.infer<typeof updateProviderLinkSchema>;
