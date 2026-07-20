/**
 * Esquemas Zod del modulo de pagos.
 *
 * Dos puertas de entrada, misma tabla `payments`:
 *   - EL CLIENTE paga lo suyo (permiso package.pay): elige tarjeta o deposito.
 *     No manda el monto: lo pone el servidor desde el monto de factura congelado,
 *     porque dejar que el pagador declare cuanto debe seria confiar en el cliente.
 *   - EL STAFF registra un abono a mano (permiso payments.validate): es la
 *     "Informacion de Pago" del manual (docs/manuales/flujo.md L84-88), donde SI
 *     digita cuenta, comprobante, fecha y monto de un deposito ya recibido.
 *
 * La moneda y la tasa de cambio son obligatorias en el borde de entrada (reglas
 * M2 y M5): ningun monto entra al sistema sin ellas.
 */
import { z } from 'zod';
import { Currency } from '../money/currency';
import { BankAccount, PaymentMethod } from './payment';

/**
 * Monto de un abono. No negativo (regla M3) y con techo defensivo: un pago de
 * mas de mil millones es un error de digitacion, no un caso de negocio.
 */
export const paymentAmountSchema = z
  .number({ invalid_type_error: 'El monto debe ser un número.' })
  .nonnegative('El monto no puede ser negativo.')
  .max(1_000_000_000, 'El monto es demasiado grande.');

/**
 * Colones por 1 USD (convencion unica del sistema). Obligatoria al guardar un
 * monto (regla M5) incluso si el pago viene en colones: la tasa es el testigo
 * historico que permite reexpresar el abono en la otra moneda mañana.
 */
export const exchangeRateSchema = z
  .number({ invalid_type_error: 'La tasa de cambio debe ser un número.' })
  .positive('La tasa de cambio debe ser mayor que cero.')
  .max(10_000, 'La tasa de cambio no parece válida.');

const receiptNumberSchema = z
  .string()
  .trim()
  .min(1, 'Indica el número de comprobante.')
  .max(60, 'El número de comprobante es demasiado largo.');

/** Instante en UTC (ISO 8601). La hora local se convierte en la presentacion. */
const instantSchema = z.string().datetime({ offset: true, message: 'Fecha inválida.' });

const noteSchema = z.string().trim().max(500, 'La nota es demasiado larga.');

// ---------------------------------------------------------------------------
// Pago iniciado por el cliente (permiso package.pay)
// ---------------------------------------------------------------------------

/**
 * El cliente paga un tramite suyo. NO lleva monto ni moneda: el servidor cobra el
 * monto de factura congelado del tramite y captura la tasa del dia. Lo unico que
 * elige el cliente es COMO paga, y esa eleccion aun la filtra su tarifa (una
 * tarifa que no admite tarjeta no ofrece la opcion).
 *
 * En deposito bancario el comprobante se sube aparte (multipart) contra
 * `/payments/:id/receipt`: mezclar archivo y JSON en un mismo cuerpo obligaria a
 * validar el pago y el adjunto en la misma transaccion.
 */
export const startPaymentSchema = z.object({
  shipmentId: z.string().uuid('Trámite inválido.'),
  method: z.nativeEnum(PaymentMethod, {
    errorMap: () => ({ message: 'Elige un medio de pago válido.' }),
  }),
  /** Solo deposito: datos que el cliente ya conoce al subir su comprobante. */
  bankAccount: z.nativeEnum(BankAccount).optional(),
  receiptNumber: receiptNumberSchema.optional(),
  depositedAt: instantSchema.optional(),
});
export type StartPaymentInput = z.infer<typeof startPaymentSchema>;

// ---------------------------------------------------------------------------
// Registro manual por el staff (permiso payments.validate)
// ---------------------------------------------------------------------------

/**
 * "Informacion de Pago" del manual: el staff registra un deposito que ya entro a
 * la cuenta. Nace CONFIRMADO —quien lo digita es justamente quien lo valido
 * contra el estado de cuenta— asi que aqui el monto si viaja en el cuerpo, con su
 * moneda y su tasa.
 */
export const recordPaymentSchema = z.object({
  shipmentId: z.string().uuid('Trámite inválido.'),
  amount: paymentAmountSchema,
  currency: z.nativeEnum(Currency, {
    errorMap: () => ({ message: 'Elige la moneda del monto.' }),
  }),
  exchangeRate: exchangeRateSchema,
  bankAccount: z.nativeEnum(BankAccount, {
    errorMap: () => ({ message: 'Elige la cuenta donde entró el depósito.' }),
  }),
  receiptNumber: receiptNumberSchema,
  depositedAt: instantSchema,
  note: noteSchema.optional(),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

/**
 * Resolucion de un pago pendiente por el staff: confirmarlo o rechazarlo. El
 * rechazo exige nota porque el cliente tiene que saber que corregir.
 */
export const resolvePaymentSchema = z
  .object({
    confirm: z.boolean(),
    note: noteSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.confirm && !data.note?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'Indica por qué se rechaza el pago.',
      });
    }
  });
export type ResolvePaymentInput = z.infer<typeof resolvePaymentSchema>;

/** Filtros del listado de pagos (bandeja de validacion del staff). */
export const listPaymentsQuerySchema = z.object({
  shipmentId: z.string().uuid().optional(),
  status: z.string().trim().optional(),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
