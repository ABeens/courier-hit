/**
 * Esquemas Zod del modulo de pagos.
 *
 * Dos puertas de entrada, misma tabla `payments`:
 *   - EL CLIENTE paga lo suyo (permiso package.pay): elige tarjeta o deposito.
 *     No manda el monto: lo pone el servidor desde el monto de factura congelado,
 *     porque dejar que el pagador declare cuanto debe seria confiar en el cliente.
 *   - EL STAFF registra un abono a mano (permiso payments.record): es la
 *     "Informacion de Pago" del manual (docs/manuales/flujo.md L84-88), donde SI
 *     digita cuenta, comprobante, fecha y monto de un deposito ya recibido. Con
 *     que situacion nace ese abono no lo decide el cuerpo sino quien lo manda
 *     (`recordedPaymentStatus`): el Operativo lo deja en validacion y el
 *     Administrador, que ademas puede aprobarlo, confirmado.
 *
 * La moneda es obligatoria en el borde de entrada (regla M2) y la tasa de cambio
 * lo es AL GUARDAR (regla M5): ningun abono se persiste sin las dos. Que el
 * cuerpo la traiga o la ponga el servidor depende de quien registra (ver
 * `recordPaymentSchema`), pero la fila siempre acaba con una tasa validada.
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
export const startPaymentSchema = z
  .object({
    shipmentId: z.string().uuid('Trámite inválido.'),
    method: z.nativeEnum(PaymentMethod, {
      errorMap: () => ({ message: 'Elige un medio de pago válido.' }),
    }),
    /** Solo deposito: datos que el cliente ya conoce al subir su comprobante. */
    bankAccount: z
      .nativeEnum(BankAccount, {
        errorMap: () => ({ message: 'Elige la cuenta donde hiciste el depósito.' }),
      })
      .optional(),
    receiptNumber: receiptNumberSchema.optional(),
    depositedAt: instantSchema.optional(),
  })
  .superRefine((data, ctx) => {
    /**
     * En deposito la cuenta es OBLIGATORIA: el requerimiento pide guardar "a cual
     * cuenta realizo el deposito", y un abono sin cuenta obliga a quien valida a
     * revisar los cuatro estados de cuenta para encontrarlo. Con tarjeta no aplica
     * y el servidor la ignora. QUE cuentas son validas depende del tipo de tramite
     * y eso lo decide el servidor, que es quien conoce el tramite.
     */
    if (data.method === PaymentMethod.DepositoBancario && !data.bankAccount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bankAccount'],
        message: 'Elige la cuenta donde hiciste el depósito.',
      });
    }
  });
export type StartPaymentInput = z.infer<typeof startPaymentSchema>;

/**
 * Correccion de la cuenta de un deposito por el staff, con la nota de por que.
 *
 * Va por su propia puerta y no dentro de `resolvePaymentSchema` porque el
 * requerimiento dice "LUEGO puede indicar": la correccion tambien ocurre sobre
 * pagos ya confirmados, cuando el estado de cuenta aparece dias despues y el
 * dinero no estaba donde el cliente dijo. Colgarla de la validacion la habria
 * dejado disponible solo en la ventana en que el pago esta pendiente.
 *
 * Es lo UNICO que se puede corregir de un pago: el monto, la moneda y la tasa
 * siguen siendo un snapshot inmutable (ver payments.schema.ts).
 */
export const updateBankAccountSchema = z.object({
  bankAccount: z.nativeEnum(BankAccount, {
    errorMap: () => ({ message: 'Elige la cuenta donde entró el depósito.' }),
  }),
  note: noteSchema.optional(),
});
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;

// ---------------------------------------------------------------------------
// Registro manual por el staff (permiso payments.record)
// ---------------------------------------------------------------------------

/**
 * "Informacion de Pago" del manual: el staff registra un deposito que el cliente
 * ya hizo. Aqui el monto SI viaja en el cuerpo, con su moneda: no se deduce del
 * saldo porque un deposito puede ser parcial, venir por otra moneda o traer un
 * centimo de diferencia, y lo que se asienta es lo que dice el comprobante.
 *
 * Lo que NO decide este cuerpo es si el abono queda confirmado: eso sale del
 * permiso de quien lo manda (`recordedPaymentStatus`). Registrar y aprobar son
 * dos actos distintos y el segundo es solo del administrador.
 */
export const recordPaymentSchema = z.object({
  shipmentId: z.string().uuid('Trámite inválido.'),
  amount: paymentAmountSchema,
  currency: z.nativeEnum(Currency, {
    errorMap: () => ({ message: 'Elige la moneda del monto.' }),
  }),
  /**
   * Tasa con la que se congela el abono (regla M5). OPCIONAL EN EL BORDE, nunca
   * en la fila: quien no puede fijar la tasa (`canSetExchangeRate`) no tiene por
   * que digitarla, y el servidor la resuelve con la de la factura (la que ademas
   * cuadra el abono con lo cobrado) o con la global. Exigirla aqui obligaria a
   * la pantalla del Operativo a inventar un numero que el servidor iba a
   * descartar de todos modos. Venga o se resuelva, pasa por este mismo esquema
   * antes de guardarse: presente y mayor que cero.
   */
  exchangeRate: exchangeRateSchema.optional(),
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

/**
 * Desenlace SIMULADO de un cobro con tarjeta, para el flujo de prueba que corre
 * sin credenciales de la pasarela. Solo existe fuera de produccion.
 */
export const simulatePaymentSchema = z.object({
  approve: z.boolean(),
});
export type SimulatePaymentInput = z.infer<typeof simulatePaymentSchema>;

/**
 * Lo que el navegador necesita para abrir el formulario de tarjeta, tal como lo
 * devuelve `POST /payments`. Onvo no usa un secreto de un solo uso: el SDK web se
 * inicializa con la llave publicable y el ID del intento.
 */
export interface PaymentIntentDto {
  paymentIntentId: string;
  publicKey: string;
  customerId: string | null;
  /** True si lo produjo la pasarela simulada; la web entonces no carga el SDK. */
  simulated: boolean;
}

/** Filtros del listado de pagos (bandeja de validacion del staff). */
export const listPaymentsQuerySchema = z.object({
  shipmentId: z.string().uuid().optional(),
  status: z.string().trim().optional(),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
