/**
 * Esquemas Zod del alta y consulta de tramites.
 * Fuente: docs/manuales/flujo.md L73-145 (alta por administrador) y
 * "Requerimientos Parte 2 - Portal Cliente" L45-71 (prealerta por el cliente).
 *
 * Dos puertas de entrada, misma tabla:
 *   - PREALERTA (cliente, permiso prealert.create): datos minimos. El cliente
 *     solo declara lo que sabe al comprar; el peso y el resto los completa la
 *     operacion cuando el paquete llega.
 *   - ALTA (administrador, permiso package.write / tramite.manage): el juego
 *     completo de campos, incluido el cliente al que pertenece.
 *
 * En ambos casos el estado inicial NO se acepta del cliente: lo fija el servidor
 * con `initialState(flow)` (siempre Prealertado).
 */
import { z } from 'zod';
import { ShipmentType } from '../workflow/shipment-type';
import { State } from '../workflow/states';
import { CARRIERS, STORES } from './catalogs';
import { usesPackageFields } from './shipment';

// ---------------------------------------------------------------------------
// Campos base
// ---------------------------------------------------------------------------

/**
 * Guia del tramite: tracking de Paqueteria o AWB/BL de Transporte. El manual
 * pide "alfanumerico" para Paqueteria y "alfanumerico con guiones" para AWB/BL
 * (L76, L111); se admite el guion en ambos porque muchos trackings reales lo
 * llevan y rechazarlos bloquearia altas legitimas. Se normaliza a mayusculas
 * para que la busqueda por tracking no dependa de como se digito.
 */
export const trackingSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(3, 'El tracking es demasiado corto.')
  .max(40, 'El tracking es demasiado largo.')
  .regex(/^[A-Z0-9-]+$/, 'El tracking solo admite letras, números y guiones.');

/** Descripcion / REF. Texto libre: el manual ejemplifica "CHEVROLET SPARK VIN583378". */
export const descriptionSchema = z
  .string()
  .trim()
  .min(1, 'La descripción es obligatoria.')
  .max(200, 'La descripción es demasiado larga.');

/**
 * HAWB, el identificador que le pone la bodega de Miami al paquete. La operacion
 * lo llama LES, y asi se nombra en la UI ("HAWB (LES)"): es el nombre por el que
 * el cliente lo pregunta.
 *
 * Formato de la etiqueta: prefijo de letras + consecutivo, p. ej. "LES48450141".
 * El manual lo describia como numerico (docs/manuales/flujo.md L114), pero lo
 * que la pistola lee en la mesa de bodega es la cadena COMPLETA, prefijo
 * incluido; exigir solo digitos hacia que ningun paquete real se pudiera
 * recibir. Se normaliza a MAYUSCULAS porque el mismo LES escaneado en otra caja
 * no puede resolver a un tramite distinto.
 */
export const hawbSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{1,30}$/, 'El HAWB (LES) solo admite letras, números y guiones.');

/** DUA con el formato del manual: ###-####-###### (docs/manuales/flujo.md L82). */
export const duaSchema = z
  .string()
  .trim()
  .regex(/^\d{3}-\d{4}-\d{6}$/, 'El DUA debe tener el formato ###-####-######.');

/** Digitos del DUA por bloque: ###-####-###### = 3 + 4 + 6. */
const DUA_BLOCKS = [3, 4, 6];
export const DUA_DIGITS = DUA_BLOCKS.reduce((a, b) => a + b, 0);
/** Largo del DUA ya formateado (digitos + separadores), para `maxLength` en la UI. */
export const DUA_LENGTH = DUA_DIGITS + DUA_BLOCKS.length - 1;

/**
 * Da forma ###-####-###### a lo que el usuario digita: el guion lo pone la
 * mascara, no la persona (se escriben solo los digitos). Sirve igual para pegar
 * un DUA ya formateado, con espacios o con otros separadores.
 *
 * Solo separa bloques que existen: con 3 digitos devuelve "123", no "123-", para
 * que borrar hacia atras no se quede atascado en un guion que se repone solo.
 */
export function formatDua(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, DUA_DIGITS);
  const blocks: string[] = [];
  let at = 0;
  for (const size of DUA_BLOCKS) {
    if (at >= digits.length) break;
    blocks.push(digits.slice(at, at + size));
    at += size;
  }
  return blocks.join('-');
}

/**
 * Peso declarado en kilos. Se acepta con decimales (la bascula los da) y el
 * servidor lo redondea hacia arriba al guardar con `roundWeightKg`.
 */
export const weightKgSchema = z
  .number({ invalid_type_error: 'El peso debe ser un número.' })
  .positive('El peso debe ser mayor que cero.')
  .max(10_000, 'El peso es demasiado grande.');

const storeSchema = z.enum(STORES, {
  errorMap: () => ({ message: 'Elige una tienda de la lista.' }),
});

const carrierSchema = z.enum(CARRIERS, {
  errorMap: () => ({ message: 'Elige un transportista de la lista.' }),
});

const warehouseSchema = z.string().trim().min(1).max(100);

/**
 * Notas para facturar. Comunes a los DOS flujos: el reporte las pide igual en
 * Paqueteria (campo 20) que en Agenciamiento (campo 19).
 */
const billingNotesSchema = z.string().trim().min(1).max(500);

/**
 * Consecutivo de la factura electronica. Es un identificador EXTERNO: lo emite el
 * sistema de facturacion y aqui solo se anota, asi que se acepta tal cual (letras,
 * digitos y separadores) sin imponerle un formato que el proveedor podria cambiar.
 * Se normaliza a mayusculas para que buscar por el no dependa de como se digito.
 */
const electronicInvoiceNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'El número de factura electrónica no puede ir vacío.')
  .max(40, 'El número de factura electrónica es demasiado largo.')
  .regex(/^[A-Z0-9][A-Z0-9-]*$/, 'El número solo admite letras, números y guiones.');

/**
 * Valor comercial declarado, en USD (moneda explicita, regla M2; solo USD como
 * el resto de la paqueteria). Lo captura el cliente al prealertar: es lo que pago
 * por la compra y alimenta `valor_comercial` de la prealerta del proveedor.
 * Positivo (una compra real vale mas que cero); el redondeo a 2 decimales lo hace
 * el servidor con `roundMoney`, no la UI. No lleva tasa de cambio: es un valor
 * declarado, no un cobro (M5 no aplica).
 */
export const declaredValueUsdSchema = z
  .number({ invalid_type_error: 'El valor declarado debe ser un número.' })
  .positive('El valor declarado debe ser mayor que cero.')
  .max(1_000_000, 'El valor declarado es demasiado grande.');

/**
 * Valor asegurado, en USD. Solo lo fija el staff; 0 o mas (0 = sin seguro, que es
 * lo habitual de HS Global). Misma naturaleza que el valor declarado: USD, sin tasa.
 */
export const insuredValueUsdSchema = z
  .number({ invalid_type_error: 'El valor asegurado debe ser un número.' })
  .nonnegative('El valor asegurado no puede ser negativo.')
  .max(1_000_000, 'El valor asegurado es demasiado grande.');

/** Posicion arancelaria (codigo aduanero del contenido). Texto corto; solo staff. */
const tariffPositionSchema = z.string().trim().min(1).max(30);

// ---------------------------------------------------------------------------
// Coherencia tipo <-> campos
// ---------------------------------------------------------------------------

/**
 * Los campos de Paqueteria (tienda, transportista, HAWB, peso) y los de
 * Transporte/Agenciamiento (almacen, DUA) son excluyentes: pertenecen a flujos
 * distintos. Enviar un campo del flujo equivocado es un error del cliente, no
 * algo que se ignore en silencio.
 *
 * Las notas para facturar NO estan en ninguna de las dos listas: nacieron como
 * campo de Transporte porque asi las listaba el manual, pero facturar un paquete
 * necesita las mismas anotaciones y el reporte las pide en los dos flujos. Lo
 * mismo el consecutivo de factura electronica.
 */
function refineTypeFieldCoherence(
  data: {
    shipmentType: ShipmentType;
    store?: unknown;
    carrier?: unknown;
    hawb?: unknown;
    weightKg?: unknown;
    declaredValueUsd?: unknown;
    insuredValueUsd?: unknown;
    tariffPosition?: unknown;
    retain?: unknown;
    warehouse?: unknown;
    dua?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  const isPackage = usesPackageFields(data.shipmentType);
  const packageOnly = [
    'store',
    'carrier',
    'hawb',
    'weightKg',
    'declaredValueUsd',
    'insuredValueUsd',
    'tariffPosition',
    'retain',
  ] as const;
  const transportOnly = ['warehouse', 'dua'] as const;

  for (const field of isPackage ? transportOnly : packageOnly) {
    if (data[field] !== undefined && data[field] !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: isPackage
          ? 'Este campo no aplica a los trámites de Paquetería.'
          : 'Este campo solo aplica a los trámites de Paquetería.',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Prealerta del cliente (permiso prealert.create)
// ---------------------------------------------------------------------------

/**
 * Prealerta hecha por el titular del casillero. NO lleva `clientId`: el dueño es
 * siempre el de la sesion, para que un cliente no pueda prealertar a nombre de
 * otro.
 *
 * SOLO PAQUETERIA. El tipo es un literal, no el enum: el cliente unicamente
 * avisa de compras que vienen en camino a Miami. Los tramites de Transporte
 * (aereo, maritimo FCL/LCL) y de Agenciamiento nacen de una gestion que negocia
 * el staff (guia aerea/BL, almacen, DUA), asi que los registra quien tiene
 * `tramite.manage` por el alta normal (`createShipmentSchema`); el titular solo
 * los consulta en "Otros tramites" (`tramite.read.own`).
 *
 * Que sea un literal y no una comprobacion en el refine es deliberado: asi el
 * tipo inferido de `PrealertShipmentInput` ya excluye los demas tipos y ningun
 * llamador puede construir una prealerta de agenciamiento ni por descuido.
 */
export const prealertShipmentSchema = z
  .object({
    shipmentType: z.literal(ShipmentType.Paqueteria, {
      errorMap: () => ({
        message: 'Solo puedes prealertar paquetes de Paquetería; los trámites de transporte y agenciamiento los registra HS Global Services.',
      }),
    }),
    tracking: trackingSchema,
    description: descriptionSchema,
    store: storeSchema.optional(),
    carrier: carrierSchema.optional(),
    /** Valor comercial declarado (USD). Obligatorio en Paqueteria: lo pide la prealerta del proveedor. */
    declaredValueUsd: declaredValueUsdSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.store) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['store'], message: 'Elige la tienda.' });
    }
    if (!data.carrier) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['carrier'], message: 'Elige el transportista.' });
    }
    // El valor declarado solo lo aporta el cliente (los demas campos del proveedor
    // —asegurado, arancel, retener— son cosa del staff y no viajan en la prealerta).
    if (data.declaredValueUsd === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['declaredValueUsd'],
        message: 'Indica el valor declarado de la compra.',
      });
    }
  });
export type PrealertShipmentInput = z.infer<typeof prealertShipmentSchema>;

// ---------------------------------------------------------------------------
// Alta por el administrador (permiso package.write / tramite.manage)
// ---------------------------------------------------------------------------

/**
 * Alta completa. El administrador elige el cliente y puede capturar de una vez
 * los datos que la operacion ya conoce (peso, HAWB, notas para facturar).
 * Almacen y DUA no van aqui: el manual los pide DESPUES de guardar (L80-83), asi
 * que llegan por el PATCH de edicion.
 */
export const createShipmentSchema = z
  .object({
    clientId: z.string().uuid('Elige un cliente.'),
    shipmentType: z.nativeEnum(ShipmentType, {
      errorMap: () => ({ message: 'Elige un tipo de trámite válido.' }),
    }),
    tracking: trackingSchema,
    description: descriptionSchema,
    // Paqueteria
    store: storeSchema.optional(),
    carrier: carrierSchema.optional(),
    hawb: hawbSchema.optional(),
    weightKg: weightKgSchema.optional(),
    // Datos para la prealerta del proveedor. El valor declarado es del cliente pero
    // el staff tambien puede capturarlo al dar el alta; los otros tres son solo suyos.
    declaredValueUsd: declaredValueUsdSchema.optional(),
    insuredValueUsd: insuredValueUsdSchema.optional(),
    tariffPosition: tariffPositionSchema.optional(),
    retain: z.boolean().optional(),
    // Comun a los dos flujos
    billingNotes: billingNotesSchema.optional(),
  })
  .superRefine((data, ctx) => {
    refineTypeFieldCoherence(data, ctx);
    if (!usesPackageFields(data.shipmentType)) return;
    if (!data.store) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['store'], message: 'Elige la tienda.' });
    }
    if (!data.carrier) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['carrier'], message: 'Elige el transportista.' });
    }
    if (data.declaredValueUsd === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['declaredValueUsd'],
        message: 'Indica el valor declarado de la compra.',
      });
    }
  });
export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;

/**
 * Edicion por el administrador. Todos los campos opcionales pero al menos uno
 * presente. `null` limpia el campo. El tipo de tramite NO se edita: cambiarlo
 * moveria el tramite a otra maquina de estados y dejaria su historial sin
 * sentido; para eso se anula y se crea de nuevo.
 *
 * La coherencia tipo <-> campos no se puede resolver aqui (el PATCH no conoce el
 * tipo del tramite guardado): la aplica el servicio de la API.
 */
export const updateShipmentSchema = z
  .object({
    tracking: trackingSchema.optional(),
    description: descriptionSchema.optional(),
    store: storeSchema.nullable().optional(),
    carrier: carrierSchema.nullable().optional(),
    hawb: hawbSchema.nullable().optional(),
    weightKg: weightKgSchema.nullable().optional(),
    declaredValueUsd: declaredValueUsdSchema.nullable().optional(),
    insuredValueUsd: insuredValueUsdSchema.nullable().optional(),
    tariffPosition: tariffPositionSchema.nullable().optional(),
    retain: z.boolean().nullable().optional(),
    warehouse: warehouseSchema.nullable().optional(),
    dua: duaSchema.nullable().optional(),
    billingNotes: billingNotesSchema.nullable().optional(),
    electronicInvoiceNumber: electronicInvoiceNumberSchema.nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No hay cambios que aplicar.' });
export type UpdateShipmentInput = z.infer<typeof updateShipmentSchema>;

// ---------------------------------------------------------------------------
// Cambio de estado
// ---------------------------------------------------------------------------

/**
 * Avance manual de un tramite. El estado destino se valida contra la maquina de
 * estados en la API (`canTransition`), no aqui: el esquema no conoce el estado
 * actual ni el tipo del tramite guardado.
 *
 * `note` es opcional en el esquema pero OBLIGATORIA cuando el estado destino
 * declara Condition.RequiresComment (p. ej. "Devuelto a bodega"). Esa regla vive
 * en la maquina, que es quien sabe a que estado se va.
 */
export const transitionShipmentSchema = z.object({
  state: z.nativeEnum(State, {
    errorMap: () => ({ message: 'Elige un estado válido.' }),
  }),
  note: z.string().trim().max(500, 'El comentario es demasiado largo.').optional(),
});
export type TransitionShipmentInput = z.infer<typeof transitionShipmentSchema>;

/**
 * Correccion administrativa del estado: la unica via para retroceder o saltar.
 *
 * No es una transicion, es una ENMIENDA. La maquina de estados describe el
 * proceso normal y por eso prohibe volver atras (`Restriction.NoRollback`);
 * meterle marcha atras la dejaria sin decir cual es el camino. La correccion
 * vive fuera de ella: se salta `canTransition`, no dispara automatizaciones y
 * queda marcada como tal en el historial.
 *
 * A diferencia del avance, la nota es OBLIGATORIA: una corrección sin motivo es
 * indistinguible de un error nuevo cuando alguien lea el historial en seis meses.
 */
export const correctStateSchema = z.object({
  state: z.nativeEnum(State, {
    errorMap: () => ({ message: 'Elige un estado válido.' }),
  }),
  note: z
    .string()
    .trim()
    .min(1, 'Indica el motivo de la corrección.')
    .max(500, 'El comentario es demasiado largo.'),
});
export type CorrectStateInput = z.infer<typeof correctStateSchema>;

/**
 * Recepcion en bodega por HAWB (LES) (Parte 4, "Recepción de Paquete"). Lo que
 * la pistola lee en la etiqueta del paquete es el LES, no el tracking de la
 * tienda: ese es el identificador que entra al sistema. El operador escanea o
 * digita el LES y el sistema resuelve el resto: si el tramite existe lo mueve a
 * "Facturación en proceso"; si no, responde con un codigo estable para que la
 * web abra el alta manual.
 */
export const receiveShipmentSchema = z.object({
  hawb: hawbSchema,
});
export type ReceiveShipmentInput = z.infer<typeof receiveShipmentSchema>;

// ---------------------------------------------------------------------------
// Listado
// ---------------------------------------------------------------------------

/**
 * Extremo del filtro de rango: INSTANTE en UTC (ISO 8601), no fecha suelta.
 * El usuario elige dias en su hora local; convertir ese dia a instantes es
 * trabajo de la capa de presentacion (CLAUDE.md: almacenar y transportar en UTC).
 * Si la API recibiera 'YYYY-MM-DD' tendria que asumir una zona horaria, y esa
 * suposicion es justo lo que la regla prohibe.
 */
const instantSchema = z.string().datetime({ offset: true, message: 'Fecha inválida.' });

/**
 * Filtros del dashboard (docs/manuales/flujo.md L103: "el Dashboard debe poder
 * aplicar filtros. Uno de ellos es Rango de Fechas"). `q` busca por consecutivo,
 * tracking, descripcion o nombre/codigo del cliente.
 *
 * `shipmentType` acepta varios valores separados por coma para que un mismo
 * endpoint sirva los tres dashboards del manual (Paqueteria, Transporte y
 * Agenciamiento, y Todos) sin multiplicar rutas.
 */
export const listShipmentsQuerySchema = z.object({
  q: z.string().trim().optional(),
  shipmentType: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(z.nativeEnum(ShipmentType)).nonempty().optional()),
  state: z.nativeEnum(State).optional(),
  clientId: z.string().uuid().optional(),
  /** Inicio del rango por fecha de ingreso, inclusive. */
  from: instantSchema.optional(),
  /** Fin del rango por fecha de ingreso, exclusivo (la web manda el inicio del dia siguiente). */
  to: instantSchema.optional(),
});
export type ListShipmentsQuery = z.infer<typeof listShipmentsQuerySchema>;
