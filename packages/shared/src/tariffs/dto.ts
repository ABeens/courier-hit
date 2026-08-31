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
 * COMO se cobra el kilo y COMO se salda la deuda, que son dos reglas del sistema
 * y no un dato del catalogo.
 *
 *   - `Estandar`: todas las tarifas de siempre (Basica, Premium, VIP...). El kilo
 *     se cobra REDONDEADO HACIA ARRIBA (`roundWeightKg`, flujo.md L115) y cada
 *     paquete se paga por su cuenta.
 *   - `Consolidada`: el kilo se cobra por el PESO REAL de bascula, sin redondear,
 *     y el cliente salda de una sola vez TODOS sus paquetes listos para facturar
 *     (pago agrupado). No se puede elegir cuales entran: entran todos.
 *
 * Es un enum y no un booleano `esConsolidada` porque el requisito lo nombra como
 * un tipo ("creacion del tipo de tarifa Consolidada") y porque las dos reglas que
 * cuelgan de el ya son dos: sumar una tercera modalidad no obliga a inventar un
 * segundo booleano que contradiga al primero.
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
    'Cobra el peso redondeado hacia arriba (1.1 kg se cobra como 2) y cada paquete se paga por separado.',
  [ClientRateKind.Consolidada]:
    'Cobra el peso real del paquete, sin redondear, y el cliente salda todos sus paquetes listos en un solo pago.',
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

/**
 * La tarifa se salda con un PAGO AGRUPADO: todos los paquetes listos para
 * facturar del casillero en un solo cobro, sin poder elegir cuales.
 *
 * Punto UNICO, igual que arriba: lo consultan la cotizacion del grupo, la guarda
 * que rechaza el pago suelto de un paquete consolidado y la pantalla que decide
 * que boton pintar. Responder distinto en cualquiera de los tres es como un
 * paquete consolidado acaba pagado por fuera del grupo.
 */
export function billsAsGroup(kind: ClientRateKind): boolean {
  return kind === ClientRateKind.Consolidada;
}

/** Tarifa preferencial de cliente (vista publica; forma equivalente a la fila de BD). */
export interface ClientRate {
  id: string;
  name: string;
  /** Tipo de tarifa: decide el redondeo del peso y si el cobro es agrupado. */
  kind: ClientRateKind;
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

/** Tipo de tarifa. Ausente = `Estandar`, que es como se comportan las de siempre. */
const kindSchema = z.nativeEnum(ClientRateKind, {
  errorMap: () => ({ message: 'Elige un tipo de tarifa válido.' }),
});

/**
 * REGLA: la tarifa por defecto no puede ser Consolidada.
 *
 * La default es a la que caen los casilleros nuevos y la que se usa cuando un
 * casillero se queda sin tarifa (`rateFor`). Consolidada de por defecto pondria a
 * TODO cliente nuevo en cobro agrupado y peso sin redondear sin que nadie lo haya
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
    /** Ausente = false: una tarifa normal factura sola, que es el caso corriente. */
    requiresBillingReview: z.boolean().optional(),
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
    requiresBillingReview: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No hay cambios que aplicar.' })
  .superRefine(assertKindAllowsDefault);
export type UpdateClientRateInput = z.infer<typeof updateClientRateSchema>;
