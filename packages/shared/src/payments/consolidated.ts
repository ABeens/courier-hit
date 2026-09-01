/**
 * PAGO AGRUPADO de una cuenta consolidada.
 *
 * Un cliente con tarifa Consolidada (`ClientRateKind.Consolidada`) no paga
 * paquete por paquete: salda de una sola vez TODOS sus paquetes listos para
 * facturar. Este archivo tiene la forma de ese cobro y las dos reglas que lo
 * distinguen de un pago corriente.
 *
 * REGLA 1 — EL GRUPO NO SE ELIGE, SE CALCULA. El conjunto de paquetes lo arma el
 * servidor con los que estan listos para facturar; el cuerpo de la peticion no
 * lleva ids de tramite y no hay forma de excluir, quitar ni agregar uno. Es el
 * requisito, y ademas es lo unico coherente: si el cliente pudiera dejar dos
 * paquetes fuera, la "consolidacion" seria una seleccion mas.
 *
 * REGLA 2 — EL GRUPO CUBRE EL SALDO ENTERO. No hay abono parcial agrupado: el
 * importe es la suma de los saldos de todos los paquetes del grupo. Un deposito
 * por menos se registra contra el paquete que corresponda por la via de siempre.
 *
 * COMO SE GUARDA. El grupo es una fila propia (`payment_groups`) y CADA paquete
 * conserva su abono en `payments`, apuntando al grupo. No es duplicacion: es lo
 * que deja intacto todo lo que ya pregunta "este tramite esta pagado"
 * (`isSettled`, la guarda de salida a ruta, el estatus de cobro del reporte). Un
 * unico abono colgado del cliente habria obligado a reescribir esas tres
 * respuestas para que supieran repartir un monto entre varios tramites.
 */
import { z } from 'zod';
import { Currency } from '../money/currency';
import { BankAccount, PaymentMethod, PaymentStatus } from './payment';

/** Un paquete dentro del grupo, tal como se lista antes y despues de cobrar. */
export interface ConsolidatedItem {
  shipmentId: string;
  /** Consecutivo de negocio del tramite (`HSX000001000`). */
  code: string;
  tracking: string;
  description: string;
  /** Peso REAL de bascula: es el que cobra la tarifa consolidada. */
  weightKg: number | null;
  invoiceTotalUsd: number | null;
  invoiceTotalCrc: number | null;
  /** Ya abonado y confirmado de ESTE paquete. */
  settledUsd: number;
  settledCrc: number;
  /** Lo que falta por cobrar de ESTE paquete. */
  dueUsd: number;
  dueCrc: number;
}

/**
 * Lo que la pantalla de pago agrupado necesita para dibujarse: quien es el
 * cliente, que paquetes entran (todos, sin eleccion posible), cuanto suman y con
 * que se puede pagar.
 *
 * Es el equivalente de `/payments/quote/:shipmentId` para el grupo, y se parece a
 * proposito: la web reusa las mismas funciones de dinero (`billingAmounts`).
 */
export interface ConsolidatedQuoteDto {
  /**
   * FALSE cuando el casillero NO tiene tarifa consolidada. La cotizacion contesta
   * en vez de fallar porque la pregunta que hace la pantalla es "¿esta cuenta se
   * cobra agrupada?", y una cuenta corriente es una respuesta valida, no un error.
   * Los dos cobros (`start` y `record`) SI rechazan una cuenta no consolidada: ahi
   * ya no se esta preguntando, se esta cobrando.
   */
  consolidated: boolean;
  clientId: string;
  /** Codigo de casillero, `HS-1000`. */
  clientCode: string;
  clientName: string;
  /** Nombre de la tarifa consolidada del casillero, para nombrar el cobro. */
  rateName: string;
  /** Los paquetes del grupo. Vacio = no hay nada que cobrar todavia. */
  items: ConsolidatedItem[];
  /** Suma de las facturas de los paquetes del grupo, en las dos monedas. */
  invoiceTotalUsd: number | null;
  invoiceTotalCrc: number | null;
  settledUsd: number;
  settledCrc: number;
  pendingUsd: number;
  pendingCrc: number;
  /** Saldo del grupo en colones. Es la cifra con la que el staff cuadra el banco. */
  dueCrc: number;
  /**
   * Moneda en la que se COBRA el grupo (`chargeCurrencyFor`: un grupo es siempre
   * de paquetes, asi que dolares) y el saldo EN ESA MONEDA.
   *
   * `due` es el importe exacto que va a llevar el intento de la pasarela o que
   * hay que depositar. Viaja para que la pantalla no lo deduzca por su cuenta y
   * le anuncie al cliente una cifra distinta de la que se le va a cobrar.
   */
  chargeCurrency: Currency;
  due: number;
  /** True si el grupo entero ya esta cubierto por abonos confirmados. */
  settled: boolean;
  /** El saldo del grupo ya esta cubierto por abonos sin validar. */
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
   * de el, por la misma razon por la que "pagado" no se guarda en el tramite. Un
   * grupo esta confirmado cuando lo estan todos sus abonos.
   */
  status: PaymentStatus;
  /** Total cobrado por el grupo, en la moneda del cobro. */
  amount: number;
  currency: Currency;
  /** Colones por 1 USD congelados al crear el grupo (regla M5). */
  exchangeRate: number;
  /** Cuantos paquetes entraron. */
  itemCount: number;
  createdAt: string;
  createdByName: string | null;
}

/**
 * Situacion de un grupo a partir de la de sus abonos. Punto UNICO de esa
 * derivacion.
 *
 * El orden importa y es el mismo criterio que usa el estatus de cobro de un
 * tramite: mientras quede algo sin resolver el grupo no esta resuelto, y un
 * rechazo cualquiera tumba el grupo entero (el cobro era uno solo). Sin abonos
 * —que no deberia pasar— se responde `Rechazado`: un grupo vacio no cobro nada.
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

/**
 * El CLIENTE paga su cuenta consolidada.
 *
 * No lleva ni monto ni lista de tramites, y las dos ausencias son la regla, no un
 * atajo: el importe lo pone el servidor desde las facturas congeladas (igual que
 * en el pago suelto) y el conjunto de paquetes tambien, porque entran todos.
 */
export const startConsolidatedPaymentSchema = z
  .object({
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
export type StartConsolidatedPaymentInput = z.infer<typeof startConsolidatedPaymentSchema>;

/**
 * El STAFF registra el deposito agrupado que el cliente ya hizo.
 *
 * A diferencia de `recordPaymentSchema`, el monto NO viaja en el cuerpo: un
 * deposito consolidado salda el grupo entero (regla 2 de este archivo), asi que
 * el importe es el saldo del grupo y digitarlo solo abriria la puerta a un abono
 * agrupado parcial, que es justo lo que el requisito prohibe. Un deposito por
 * otra cifra se registra contra su paquete por la via de siempre.
 *
 * La tasa sigue siendo opcional en el borde y obligatoria en la fila (regla M5),
 * con la misma regla de permiso que el registro suelto (`canSetExchangeRate`).
 */
export const recordConsolidatedPaymentSchema = z.object({
  clientId: z.string().uuid('Casillero inválido.'),
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
export type RecordConsolidatedPaymentInput = z.infer<typeof recordConsolidatedPaymentSchema>;
