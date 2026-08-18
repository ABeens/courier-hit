/**
 * Dominio de "Tarifas de cliente" (panel admin, permiso tariffs.manage).
 *
 * Son las categorias preferenciales con precio por kg que se asignan a los
 * casilleros (Basica, Plus, Pro, Gold, Black, Platinum). Reglas:
 *   - Siempre existe UNA tarifa por defecto (la Basica), a la que se incorporan
 *     los casilleros nuevos; no se puede eliminar.
 *   - Al eliminar una tarifa con clientes asociados, esos clientes pasan a la
 *     tarifa por defecto (con aviso previo en la UI).
 *   - Cada tarifa indica si admite cobro por tarjeta de credito y/o por deposito
 *     bancario (al menos uno).
 *   - Cada tarifa indica si OCUPA REVISION antes de facturar (OPS-003): con la
 *     marca activa el paquete espera a que un operativo cargue los costos; sin
 *     ella el sistema le factura el flete solo y lo pasa a cobro.
 *
 * Nota: las "tarifas fijas" del manual (Permisos de Importacion, Asesoria,
 * Impuesto de aduana) NO viven aqui: son el catalogo de servicios de costo
 * (@courier/shared/costs, modulo cost-services).
 *
 * Convencion del repo: nombres de codigo en ingles; el dominio (etiquetas y
 * claves de negocio) en espanol. Ver CLAUDE.md.
 */
import { z } from 'zod';
import { Currency } from '../money/currency';

/** Tarifa preferencial de cliente (vista publica; forma equivalente a la fila de BD). */
export interface ClientRate {
  id: string;
  name: string;
  pricePerKg: number;
  /** Moneda del precio por kg (explicita, regla M2). La tasa de cambio no vive aqui. */
  currency: Currency;
  isDefault: boolean;
  allowsCard: boolean;
  allowsBankDeposit: boolean;
  /**
   * La tarifa ocupa REVISION antes de facturarse (OPS-003). Con la marca activa
   * el paquete se queda en "Facturacion en proceso" esperando que un operativo o
   * un administrador le cargue los costos adicionales y apruebe. Sin ella (el
   * caso de todas las demas tarifas) el sistema factura solo el flete al recibir
   * el paquete en bodega y lo avanza a "En bodega - Pendiente pago".
   */
  requiresBillingReview: boolean;
  /** Cuantos casilleros usan esta tarifa (para el aviso al eliminar). */
  clientCount: number;
}

/** Precio por kg: numero positivo. */
const pricePerKgSchema = z
  .number({ invalid_type_error: 'El precio debe ser un número.' })
  .positive('El precio por kg debe ser mayor que cero.');

/**
 * Monedas admitidas por la tarifa de cliente (regla M6: moneda permitida por
 * campo). Las tarifas por kg son de casillero (paqueteria comprada en USA), asi
 * que se cotizan siempre en dolares. La UI muestra la moneda pero fija en USD.
 */
export const CLIENT_RATE_CURRENCIES: Currency[] = [Currency.USD];

/** Moneda de la tarifa. Obligatoria (regla M2) y acotada a las admitidas (M6). */
const currencySchema = z
  .nativeEnum(Currency, { errorMap: () => ({ message: 'Elige una moneda válida (CRC o USD).' }) })
  .refine((c) => CLIENT_RATE_CURRENCIES.includes(c), {
    message: 'Las tarifas de cliente se cotizan en dólares (USD).',
  });

/** Crear tarifa de cliente. Debe permitir al menos un medio de pago. */
export const createClientRateSchema = z
  .object({
    name: z.string().trim().min(1, 'El nombre es obligatorio.'),
    pricePerKg: pricePerKgSchema,
    currency: currencySchema,
    allowsCard: z.boolean(),
    allowsBankDeposit: z.boolean(),
    /** Ausente = false: una tarifa normal factura sola, que es el caso corriente. */
    requiresBillingReview: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((o) => o.allowsCard || o.allowsBankDeposit, {
    message: 'La tarifa debe permitir al menos un medio de pago.',
    path: ['allowsCard'],
  });
export type CreateClientRateInput = z.infer<typeof createClientRateSchema>;

/**
 * Editar tarifa de cliente. Todos opcionales pero al menos uno presente. Marcar
 * `isDefault: true` promueve esta tarifa a por defecto (la anterior deja de serlo).
 * No se puede poner `isDefault: false` directamente: hay que promover otra.
 */
export const updateClientRateSchema = z
  .object({
    name: z.string().trim().min(1, 'El nombre es obligatorio.').optional(),
    pricePerKg: pricePerKgSchema.optional(),
    currency: currencySchema.optional(),
    allowsCard: z.boolean().optional(),
    allowsBankDeposit: z.boolean().optional(),
    requiresBillingReview: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No hay cambios que aplicar.' });
export type UpdateClientRateInput = z.infer<typeof updateClientRateSchema>;
