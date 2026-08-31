/**
 * Contrato de la API PUBLICA (`/api/v1`), la que consumen los sistemas de los
 * clientes con su llave (docs/16).
 *
 * Por que este contrato es SUYO y no el del portal. Los DTO internos
 * (`ShipmentDto` y compañia) cambian cuando cambia una pantalla: nacen campos,
 * se renombran, se derivan cifras nuevas. Un integrador externo no puede pagar
 * ese ritmo, asi que la API publica expone una forma propia, mas estrecha y
 * estable, y la capa que la sirve traduce. El precio es un mapeo a mano; la
 * compra es poder rehacer el portal sin romperle el ERP a nadie.
 *
 * Que NO sale por aqui, a proposito:
 *   - Nada de la trastienda: costos, margen, quien movio el tramite, notas
 *     internas de la operacion.
 *   - Nada de otro casillero: la llave identifica a UN cliente y todo lo que se
 *     devuelve esta acotado a el (ver `publicApi.assertOwnClient`).
 */
import { z } from 'zod';
import { paginationQuerySchema } from '../http/pagination';
import { CARRIERS, STORES } from '../shipments/catalogs';
import { descriptionSchema, declaredValueUsdSchema, trackingSchema } from '../shipments/dto';
import { State } from '../workflow/states';

/** Version del contrato. Va en la URL: `/api/v1/...`. */
export const PUBLIC_API_VERSION = 'v1';

/** Raiz de la API publica bajo el mismo host que el sitio. */
export const PUBLIC_API_PREFIX = `/api/${PUBLIC_API_VERSION}`;

/** Cabecera alternativa a `Authorization: Bearer` para clientes que no la manejan. */
export const API_KEY_HEADER = 'x-api-key';

/** Instante UTC en ISO 8601. Mismo criterio que el resto de la API. */
const instantSchema = z
  .string()
  .datetime({ offset: true, message: 'La fecha debe ser un instante ISO 8601 válido.' });

/**
 * Filtros del listado de paquetes. Deliberadamente cortos: estado, tracking y
 * rango de fechas cubren las preguntas reales de un integrador ("que tengo
 * prealertado", "donde va este", "que entro este mes").
 *
 * `clientCode` existe pero NO amplia el alcance: sirve para que un sistema que
 * maneja varios casilleros pueda afirmar contra cual esta preguntando y recibir
 * un error claro si se equivoco de llave, en vez de una lista vacia que parece
 * un problema de datos. Si no coincide con el casillero de la llave, es 403.
 */
export const publicPackagesQuerySchema = z
  .object({
    state: z.nativeEnum(State, {
      errorMap: () => ({ message: 'El estado no es uno de los del sistema.' }),
    }).optional(),
    /** Coincidencia EXACTA, no parcial: es un identificador, no una búsqueda. */
    tracking: trackingSchema.optional(),
    /** Casillero contra el que se pregunta; debe ser el de la llave. */
    clientCode: z.string().trim().toUpperCase().max(20).optional(),
    /** Inicio del rango por fecha de ingreso, inclusive. */
    from: instantSchema.optional(),
    /** Fin del rango por fecha de ingreso, exclusivo. */
    to: instantSchema.optional(),
  })
  .merge(paginationQuerySchema);
export type PublicPackagesQuery = z.infer<typeof publicPackagesQuerySchema>;

/**
 * Alta de prealerta por la API publica.
 *
 * No lleva `shipmentType` ni `clientId`, al reves que el esquema del portal: el
 * tipo es siempre Paqueteria (es lo unico que un cliente puede prealertar) y el
 * dueño es el de la llave. Un cuerpo que aceptara cualquiera de los dos seria una
 * invitacion a probar suerte.
 */
export const publicPrealertSchema = z.object({
  tracking: trackingSchema,
  description: descriptionSchema,
  store: z.enum(STORES, { errorMap: () => ({ message: 'La tienda no es una de las del catálogo.' }) }),
  carrier: z.enum(CARRIERS, {
    errorMap: () => ({ message: 'El transportista no es uno de los del catálogo.' }),
  }),
  declaredValueUsd: declaredValueUsdSchema,
});
export type PublicPrealertInput = z.infer<typeof publicPrealertSchema>;

/** Una linea de la direccion de Miami, lista para pegar en un formulario. */
export interface PublicLockerLine {
  label: string;
  value: string;
}

/** Casillero del cliente: lo que responde `GET /v1/locker`. */
export interface PublicLocker {
  /** Codigo de casillero, `HS-1000`. */
  clientCode: string;
  /** Sub-casillero del proveedor en Miami; `null` si aún no está activo. */
  subLocker: string | null;
  /** La dirección ya armada, línea a línea. */
  lines: PublicLockerLine[];
}

/** La cuenta detras de la llave: lo que responde `GET /v1/client`. */
export interface PublicClient {
  clientCode: string;
  name: string;
  email: string;
  /** Fecha de alta del casillero (solo día, sin hora). */
  memberSince: string | null;
}

/**
 * Un paquete visto desde fuera. Las cifras llevan su moneda en el nombre del
 * campo (regla M2): `invoiceTotalCrc` no se puede confundir con dolares.
 */
export interface PublicPackage {
  /** Consecutivo interno, `HSX-1000`. Es el que citar al escribirnos. */
  code: string;
  tracking: string;
  description: string;
  /** Clave estable del estado; sobre esta se ramifica. */
  state: State;
  /** Etiqueta en español del estado, para pintarla sin traducirla. */
  stateLabel: string;
  store: string | null;
  carrier: string | null;
  /** Identificador de la bodega de Miami (LES); `null` hasta que llega. */
  hawb: string | null;
  /** Peso facturable en kg; `null` hasta que se pesa en bodega. */
  weightKg: number | null;
  declaredValueUsd: number | null;
  /** Total facturado en colones; `null` mientras no haya factura aprobada. */
  invoiceTotalCrc: number | null;
  /** Total facturado en dólares (Paquetería); `null` si no aplica. */
  invoiceTotalUsd: number | null;
  /** Saldo pendiente en colones. 0 cuando está pagado. */
  pendingCrc: number;
  /** True cuando la factura está cubierta por pagos confirmados. */
  settled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Sobre de los listados de la API publica. Mismo contrato que el interno. */
export interface PublicPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
