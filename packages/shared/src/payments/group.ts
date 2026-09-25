/**
 * COBRO DE PROFORMAS (docs/proformas-cambios.html, area 5).
 *
 * Todo se paga por proforma completa (decision D2). El cliente elige cuales de
 * sus proformas aprobadas paga, y un solo cobro (tarjeta o deposito) puede
 * cubrir varias (decisiones P1 y P17). Las reglas:
 *
 * REGLA 1 — PROFORMAS COMPLETAS. No hay abono parcial: el importe es el saldo
 * entero de las proformas elegidas y lo pone el servidor, no el cuerpo de la
 * peticion (regla 6 del SOW).
 *
 * REGLA 2 — UNA MONEDA POR COBRO. Cada proforma se cobra en la moneda de su
 * flujo; un cobro no mezcla dolares con colones.
 *
 * COMO SE GUARDA. El cobro es una fila de `payment_groups` y CADA TRAMITE de las
 * proformas elegidas lleva su abono en `payments`, apuntando al grupo, por el
 * saldo de SU factura (que al aprobar ya incluye su parte de los servicios de la
 * proforma). Asi todo lo que pregunta "este tramite esta pagado" (`isSettled`,
 * la guarda de salida a ruta, el reporte) sigue respondiendo igual, y la
 * proforma esta pagada cuando lo estan todos sus tramites.
 */
import { z } from 'zod';
import { Currency } from '../money/currency';
import type { Flow } from '../workflow/shipment-type';
import { BankAccount, PaymentMethod, PaymentStatus } from './payment';
import type { CardCharge } from './surcharge';

/** Una proforma dentro de un cobro: lo que la pantalla lista para elegir. */
export interface ProformaPaymentItem {
  proformaId: string;
  /** Numero formateado de la proforma. */
  number: string;
  flow: Flow;
  /** Moneda en que se cobra esta proforma. */
  currency: Currency;
  shipmentCount: number;
  /** Total de la proforma en su moneda. */
  total: number;
  /** Ya confirmado, en su moneda. */
  settled: number;
  /** Lo que falta por cobrar, en su moneda. Cero si ya esta pagada. */
  due: number;
  /** Tiene un pago que cubre el saldo esperando validacion. */
  inValidation: boolean;
  approvedAt: string | null;
}

/**
 * Cotizacion del cobro de las proformas elegidas: cuanto suman, con que se
 * puede pagar y, si es con tarjeta, el cargo desglosado.
 */
export interface ProformaPaymentQuoteDto {
  clientId: string;
  clientCode: string;
  clientName: string;
  items: ProformaPaymentItem[];
  /** Moneda del cobro: la de las proformas elegidas (todas la misma). */
  chargeCurrency: Currency;
  /** El saldo exacto que va al intento de la pasarela o que hay que depositar. */
  due: number;
  /**
   * El cobro con TARJETA desglosado: saldo, comision de la pasarela y total
   * (`cardChargeFor`). Null si no se ofrece tarjeta. Aparte de `due` porque la
   * comision no es saldo: pagando por deposito no se cobra.
   */
  cardCharge: CardCharge | null;
  /** El saldo ya esta cubierto por pagos sin validar. */
  inValidation: boolean;
  availableMethods: PaymentMethod[];
  availableBankAccounts: BankAccount[];
}

/** Grupo de cobro ya creado, tal como lo devuelve la API. */
export interface PaymentGroupDto {
  id: string;
  clientId: string;
  clientCode: string;
  clientName: string;
  method: PaymentMethod;
  /**
   * Situacion del grupo. NO es una columna: se deriva de los abonos que cuelgan
   * de el, por la misma razon por la que "pagado" no se guarda en el tramite.
   */
  status: PaymentStatus;
  /** Total cobrado por el grupo, en la moneda del cobro (comision incluida). */
  amount: number;
  /** Comision de la pasarela cobrada encima. Cero en el deposito. */
  surchargeAmount: number;
  currency: Currency;
  /** Colones por 1 USD congelados al crear el grupo (regla M5). */
  exchangeRate: number;
  /** Cuantos tramites cubre. */
  itemCount: number;
  /** Numeros de las proformas que cubre. */
  proformaNumbers: string[];
  createdAt: string;
  createdByName: string | null;
}

/**
 * Situacion de un grupo a partir de la de sus abonos. Punto UNICO de esa
 * derivacion.
 *
 * Mientras quede algo sin resolver el grupo no esta resuelto, y un rechazo
 * cualquiera tumba el grupo entero (el cobro era uno solo). Sin abonos (no
 * deberia pasar) se responde `Rechazado`: un grupo vacio no cobro nada.
 */
export function paymentGroupStatus(statuses: readonly PaymentStatus[]): PaymentStatus {
  if (statuses.length === 0) return PaymentStatus.Rechazado;
  if (statuses.some((s) => s === PaymentStatus.Rechazado)) return PaymentStatus.Rechazado;
  if (statuses.some((s) => s === PaymentStatus.Iniciado)) return PaymentStatus.Iniciado;
  if (statuses.some((s) => s === PaymentStatus.Pendiente)) return PaymentStatus.Pendiente;
  return PaymentStatus.Confirmado;
}

const receiptNumberSchema = z
  .string()
  .trim()
  .min(1, 'Indica el número de comprobante.')
  .max(60, 'El número de comprobante es demasiado largo.');

/** Instante en UTC (ISO 8601). La hora local se convierte en la presentacion. */
const instantSchema = z.string().datetime({ offset: true, message: 'Fecha inválida.' });

const noteSchema = z.string().trim().max(500, 'La nota es demasiado larga.');

/** Las proformas elegidas. El tope evita un cobro de cientos de proformas por error. */
const proformaIdsSchema = z
  .array(z.string().uuid('Proforma inválida.'))
  .min(1, 'Elige al menos una proforma.')
  .max(50, 'Se pagan hasta 50 proformas por vez.');

/**
 * Cotizar: las proformas van en la query separadas por coma (`?ids=a,b`). El
 * staff indica ademas el casillero; al cliente lo acota su sesion.
 */
export const proformaPaymentQuoteQuerySchema = z.object({
  ids: z
    .string()
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(proformaIdsSchema),
  clientId: z.string().uuid().optional(),
});
export type ProformaPaymentQuoteQuery = z.infer<typeof proformaPaymentQuoteQuerySchema>;

/**
 * El CLIENTE paga las proformas que eligio. Sin monto: lo pone el servidor desde
 * las facturas congeladas (regla 1).
 */
export const startProformaPaymentSchema = z
  .object({
    proformaIds: proformaIdsSchema,
    method: z.nativeEnum(PaymentMethod, {
      errorMap: () => ({ message: 'Elige un medio de pago válido.' }),
    }),
    bankAccount: z
      .nativeEnum(BankAccount, {
        errorMap: () => ({ message: 'Elige la cuenta donde hiciste el depósito.' }),
      })
      .optional(),
    receiptNumber: receiptNumberSchema.optional(),
    depositedAt: instantSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.method === PaymentMethod.DepositoBancario && !data.bankAccount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bankAccount'],
        message: 'Elige la cuenta donde hiciste el depósito.',
      });
    }
  });
export type StartProformaPaymentInput = z.infer<typeof startProformaPaymentSchema>;

/**
 * El STAFF registra el deposito que el cliente ya hizo por unas proformas. El
 * monto no viaja: es el saldo de las proformas elegidas (regla 1). La tasa es
 * opcional en el borde y obligatoria en la fila (regla M5), y solo la manda quien
 * puede fijarla (`canSetExchangeRate`).
 */
export const recordProformaPaymentSchema = z.object({
  clientId: z.string().uuid('Casillero inválido.'),
  proformaIds: proformaIdsSchema,
  exchangeRate: z
    .number({ invalid_type_error: 'La tasa de cambio debe ser un número.' })
    .positive('La tasa de cambio debe ser mayor que cero.')
    .max(10_000, 'La tasa de cambio no parece válida.')
    .optional(),
  bankAccount: z.nativeEnum(BankAccount, {
    errorMap: () => ({ message: 'Elige la cuenta donde entró el depósito.' }),
  }),
  receiptNumber: receiptNumberSchema,
  depositedAt: instantSchema,
  note: noteSchema.optional(),
});
export type RecordProformaPaymentInput = z.infer<typeof recordProformaPaymentSchema>;

/** El administrador confirma o rechaza un cobro entero (todos sus abonos a la vez). */
export const resolvePaymentGroupSchema = z.object({
  confirm: z.boolean(),
  note: noteSchema.optional(),
});
export type ResolvePaymentGroupInput = z.infer<typeof resolvePaymentGroupSchema>;
