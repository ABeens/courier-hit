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

/**
 * TIPO de tarifa. No es una categoria comercial mas (eso es el `name`): decide
 * COMO se cobra el kilo, que es una regla del sistema y no un dato del catalogo.
 *
 *   - `Estandar`: todas las tarifas de siempre (Basica, Premium, VIP...). El kilo
 *     se cobra REDONDEADO HACIA ARRIBA (`roundWeightKg`, flujo.md L115).
 *   - `Consolidada`: el kilo se cobra por el PESO REAL de bascula, sin redondear.
 *
 * Antes la Consolidada ademas cobraba agrupado (todos los paquetes en un solo
 * pago, sin elegir). Con el modulo de proformas todos los clientes pagan por
 * proforma y eligen cuales (decisiones D3 y P8): del tipo solo queda el peso.
 *
 * Es un enum y no un booleano porque el requisito lo nombra como un tipo
 * ("creacion del tipo de tarifa Consolidada").
 *
 * Valores de dominio en espanol (CLAUDE.md): alimentan un enum de Postgres.
 */
export enum ClientRateKind {
  Estandar = 'estandar',
  Consolidada = 'consolidada',
}

export const CLIENT_RATE_KIND_LABELS: Record<ClientRateKind, string> = {
  [ClientRateKind.Estandar]: 'Estándar',
  [ClientRateKind.Consolidada]: 'Consolidada',
};

/** Que significa cada tipo, para el selector del formulario de tarifas. */
export const CLIENT_RATE_KIND_HINTS: Record<ClientRateKind, string> = {
  [ClientRateKind.Estandar]:
    'Cobra el peso redondeado hacia arriba (1.1 kg se cobra como 2).',
  [ClientRateKind.Consolidada]:
    'Cobra el peso real del paquete, sin redondear.',
};

/** Valores para construir el enum de la BD (Drizzle pgEnum), sin repetirlos. */
export const CLIENT_RATE_KIND_VALUES = Object.values(ClientRateKind) as [
  ClientRateKind,
  ...ClientRateKind[],
];

/**
 * La tarifa cobra el PESO REAL, sin el redondeo hacia arriba de las demas.
 *
 * Punto UNICO de esa pregunta: la contesta el calculo del flete y nadie mas.
 * Escrita como funcion y no como comparacion suelta para que el dia que otra
 * modalidad cobre por peso real no haya que buscar los `=== Consolidada`
 * repartidos por el codigo.
 */
export function billsActualWeight(kind: ClientRateKind): boolean {
  return kind === ClientRateKind.Consolidada;
}

/** Tarifa preferencial de cliente (vista publica; forma equivalente a la fila de BD). */
export interface ClientRate {
  id: string;
  name: string;
  /** Tipo de tarifa: decide el redondeo del peso. */
  kind: ClientRateKind;
  pricePerKg: number;
  /** Moneda del precio por kg (explicita, regla M2). La tasa de cambio no vive aqui. */
  currency: Currency;
  isDefault: boolean;
  allowsCard: boolean;
  allowsBankDeposit: boolean;
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

/** Tipo de tarifa. Ausente = `Estandar`, que es como se comportan las de siempre. */
const kindSchema = z.nativeEnum(ClientRateKind, {
  errorMap: () => ({ message: 'Elige un tipo de tarifa válido.' }),
});

/**
 * REGLA: la tarifa por defecto no puede ser Consolidada.
 *
 * La default es a la que caen los casilleros nuevos y la que se usa cuando un
 * casillero se queda sin tarifa (`rateFor`). Consolidada de por defecto pondria a
 * TODO cliente nuevo a cobrar por peso sin redondear sin que nadie lo haya
 * decidido; la consolidacion es un acuerdo comercial que se asigna casillero a
 * casillero.
 *
 * Se comprueba en el borde (aqui) y sobre el estado final en el servicio, que es
 * el unico que ve la fila que ya existe.
 */
function assertKindAllowsDefault(
  o: { kind?: ClientRateKind; isDefault?: boolean },
  ctx: z.RefinementCtx,
): void {
  if (o.kind === ClientRateKind.Consolidada && o.isDefault) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['isDefault'],
      message: 'Una tarifa consolidada no puede ser la tarifa por defecto.',
    });
  }
}

/** Crear tarifa de cliente. Debe permitir al menos un medio de pago. */
export const createClientRateSchema = z
  .object({
    name: z.string().trim().min(1, 'El nombre es obligatorio.'),
    /** Ausente = Estandar: el tipo de todas las tarifas que ya existian. */
    kind: kindSchema.optional(),
    pricePerKg: pricePerKgSchema,
    currency: currencySchema,
    allowsCard: z.boolean(),
    allowsBankDeposit: z.boolean(),
    isDefault: z.boolean().optional(),
  })
  .refine((o) => o.allowsCard || o.allowsBankDeposit, {
    message: 'La tarifa debe permitir al menos un medio de pago.',
    path: ['allowsCard'],
  })
  .superRefine(assertKindAllowsDefault);
export type CreateClientRateInput = z.infer<typeof createClientRateSchema>;

/**
 * Editar tarifa de cliente. Todos opcionales pero al menos uno presente. Marcar
 * `isDefault: true` promueve esta tarifa a por defecto (la anterior deja de serlo).
 * No se puede poner `isDefault: false` directamente: hay que promover otra.
 */
export const updateClientRateSchema = z
  .object({
    name: z.string().trim().min(1, 'El nombre es obligatorio.').optional(),
    kind: kindSchema.optional(),
    pricePerKg: pricePerKgSchema.optional(),
    currency: currencySchema.optional(),
    allowsCard: z.boolean().optional(),
    allowsBankDeposit: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No hay cambios que aplicar.' })
  .superRefine(assertKindAllowsDefault);
export type UpdateClientRateInput = z.infer<typeof updateClientRateSchema>;
