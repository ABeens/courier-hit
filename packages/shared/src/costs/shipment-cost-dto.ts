/**
 * Esquemas Zod de los costos de un tramite (permisos costs.manage /
 * costs.tramite.manage). Fuente: docs/06-modulo-administrativo.md §3.3.
 *
 * El guardado REEMPLAZA el juego completo de lineas (PUT, no PATCH por linea).
 * Es deliberado: las lineas de porcentaje se calculan sobre las demas, asi que un
 * alta o baja suelta dejaria los porcentajes desactualizados. Con el juego
 * completo, la API recalcula todo de una vez y no hay estado intermedio invalido.
 */
import { z } from 'zod';
import { Currency } from '../money/currency';
import { CostLineSource } from './shipment-cost';

/** Moneda de un campo monetario. Explicita siempre (regla M2). */
const currencySchema = z.nativeEnum(Currency, {
  errorMap: () => ({ message: 'Elige una moneda válida (CRC o USD).' }),
});

/**
 * Tasa de cambio: colones por 1 USD. Obligatoria y > 0 en TODA linea (regla M5),
 * incluso en las de dolares: es el testigo de con que tasa se emitio la factura.
 * El tope alto solo ataja dedazos (una tasa de 5 digitos no es una tasa real).
 */
const exchangeRateSchema = z
  .number({ invalid_type_error: 'Digita la tasa de cambio del día.' })
  .positive('La tasa de cambio debe ser mayor que cero.')
  .max(99_999, 'Esa tasa de cambio no parece válida.');

/** Importe de una linea: nunca negativo (regla M3). */
const amountSchema = z
  .number({ invalid_type_error: 'Digita el monto de la línea.' })
  .nonnegative('El monto no puede ser negativo.')
  .max(99_999_999, 'Ese monto excede el máximo permitido.');

/**
 * Una linea a guardar. `amount` es obligatorio salvo en las de porcentaje, donde
 * lo calcula la API sobre la base (si llegara, se ignora: el cliente no decide el
 * resultado de una formula del negocio).
 */
export const costLineInputSchema = z
  .object({
    /** Servicio del catalogo; null en el flete o en un concepto suelto. */
    costServiceId: z.string().uuid().nullable().optional(),
    label: z.string().trim().min(1, 'La línea necesita un nombre.'),
    source: z.nativeEnum(CostLineSource),
    percentage: z
      .number()
      .min(0, 'El porcentaje debe estar entre 0 y 100.')
      .max(100, 'El porcentaje debe estar entre 0 y 100.')
      .nullable()
      .optional(),
    amount: amountSchema.optional(),
    currency: currencySchema,
    exchangeRate: exchangeRateSchema,
  })
  .superRefine((line, ctx) => {
    if (line.source === CostLineSource.Percentage) {
      if (line.percentage === undefined || line.percentage === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['percentage'],
          message: 'Indica el porcentaje que se aplica.',
        });
      }
      return;
    }
    if (line.amount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'Digita el monto de la línea.',
      });
    }
  });
export type CostLineInput = z.infer<typeof costLineInputSchema>;

/** Guardar los costos de un tramite: reemplaza el juego completo de lineas. */
export const saveShipmentCostsSchema = z.object({
  lines: z.array(costLineInputSchema).max(50, 'Demasiadas líneas de costo.'),
});
export type SaveShipmentCostsInput = z.infer<typeof saveShipmentCostsSchema>;

/** Linea tal como la devuelve la API (fechas en ISO/UTC). */
export interface CostLineDto {
  id: string;
  costServiceId: string | null;
  label: string;
  source: CostLineSource;
  percentage: number | null;
  amount: number;
  currency: Currency;
  exchangeRate: number;
  createdAt: string;
}

/**
 * Linea sugerida al abrir la pantalla: el flete calculado de Paqueteria y los
 * servicios habilitados del catalogo. NO esta guardada; el operador la acepta,
 * la ajusta o la descarta.
 */
export interface SuggestedCostLine {
  costServiceId: string | null;
  label: string;
  source: CostLineSource;
  percentage: number | null;
  /** Importe sugerido; null cuando el servicio es de valor manual. */
  amount: number | null;
  currency: Currency;
  /** Por que se sugiere (p. ej. "3 kg × $13.45"). Solo informativo. */
  detail: string | null;
}

/** Respuesta de `GET /api/shipments/:id/costs`. */
export interface ShipmentCostsDto {
  shipmentId: string;
  /** Lineas guardadas. */
  lines: CostLineDto[];
  /** Sugerencias para agregar (vacio si ya esta aprobado). */
  suggestions: SuggestedCostLine[];
  totals: { usd: number; crc: number };
  /** Aprobado = congelado. Ya no admite edicion. */
  approved: boolean;
  approvedAt: string | null;
  approvedByName: string | null;
  /** Tasa sugerida del dia (BCCR); null si la integracion esta apagada o falló. */
  suggestedExchangeRate: number | null;
}
