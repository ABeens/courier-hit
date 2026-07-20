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

/** HAWB / HBL: numerico (docs/manuales/flujo.md L114). */
export const hawbSchema = z
  .string()
  .trim()
  .regex(/^\d{1,30}$/, 'El HAWB/HBL debe contener solo números.');

/** DUA con el formato del manual: ###-####-###### (docs/manuales/flujo.md L82). */
export const duaSchema = z
  .string()
  .trim()
  .regex(/^\d{3}-\d{4}-\d{6}$/, 'El DUA debe tener el formato ###-####-######.');

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
const billingNotesSchema = z.string().trim().min(1).max(500);

// ---------------------------------------------------------------------------
// Coherencia tipo <-> campos
// ---------------------------------------------------------------------------

/**
 * Los campos de Paqueteria (tienda, transportista, HAWB, peso) y los de
 * Transporte/Agenciamiento (notas para facturar, almacen, DUA) son excluyentes:
 * pertenecen a flujos distintos. Enviar un campo del flujo equivocado es un
 * error del cliente, no algo que se ignore en silencio.
 */
function refineTypeFieldCoherence(
  data: {
    shipmentType: ShipmentType;
    store?: unknown;
    carrier?: unknown;
    hawb?: unknown;
    weightKg?: unknown;
    warehouse?: unknown;
    dua?: unknown;
    billingNotes?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  const isPackage = usesPackageFields(data.shipmentType);
  const packageOnly = ['store', 'carrier', 'hawb', 'weightKg'] as const;
  const transportOnly = ['warehouse', 'dua', 'billingNotes'] as const;

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
 * otro. Paqueteria exige tienda y transportista; Transporte y Agenciamiento solo
 * la guia y la descripcion (Parte 2 L68-71).
 */
export const prealertShipmentSchema = z
  .object({
    shipmentType: z.nativeEnum(ShipmentType, {
      errorMap: () => ({ message: 'Elige un tipo de trámite válido.' }),
    }),
    tracking: trackingSchema,
    description: descriptionSchema,
    store: storeSchema.optional(),
    carrier: carrierSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (!usesPackageFields(data.shipmentType)) {
      refineTypeFieldCoherence(data, ctx);
      return;
    }
    if (!data.store) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['store'], message: 'Elige la tienda.' });
    }
    if (!data.carrier) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['carrier'], message: 'Elige el transportista.' });
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
    // Transporte y Agenciamiento
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
    warehouse: warehouseSchema.nullable().optional(),
    dua: duaSchema.nullable().optional(),
    billingNotes: billingNotesSchema.nullable().optional(),
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
 * Recepcion en bodega por tracking (Parte 4, "Recepción de Paquete"). El operador
 * escanea o digita el tracking y el sistema resuelve el resto: si el tramite
 * existe lo mueve a "Facturación en proceso"; si no, responde con un codigo
 * estable para que la web abra el alta manual.
 */
export const receiveShipmentSchema = z.object({
  tracking: trackingSchema,
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
