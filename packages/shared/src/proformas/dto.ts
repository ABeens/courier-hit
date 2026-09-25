/**
 * Contratos de la API de proformas (`/api/proformas`). Las reglas de la entidad
 * estan en `proforma.ts`; aqui solo la forma de lo que entra y sale.
 *
 * Todas las fechas viajan en ISO 8601 UTC; la pantalla las convierte a la hora
 * del usuario. Todos los montos viajan con su moneda al lado (regla M2).
 */
import { z } from 'zod';
import type { CostLineDto } from '../costs/shipment-cost-dto';
import { costLineInputSchema } from '../costs/shipment-cost-dto';
import { paginationQuerySchema } from '../http/pagination';
import type { Currency } from '../money/currency';
import { electronicInvoiceNumberSchema } from '../shipments/dto';
import { Flow } from '../workflow/shipment-type';
import type { ShipmentType } from '../workflow/shipment-type';
import type { State } from '../workflow/states';
import { ProformaDeliveryStatus, ProformaStatus } from './proforma';

/**
 * La proforma de un tramite, tal como la lleva el DTO del tramite (objetivo 11
 * del SOW: el detalle del paquete muestra en que proforma se facturo).
 */
export interface ShipmentProformaRef {
  id: string;
  /** Numero ya formateado; null si la proforma es un borrador que nunca se aprobo. */
  number: string | null;
  status: ProformaStatus;
}

/** Filtros del listado de proformas. */
export const listProformasQuerySchema = paginationQuerySchema.extend({
  status: z.nativeEnum(ProformaStatus).optional(),
  flow: z.nativeEnum(Flow).optional(),
  clientId: z.string().uuid().optional(),
  /** Busca por numero de proforma, codigo o nombre del cliente. */
  q: z.string().trim().max(100).optional(),
});
export type ListProformasQuery = z.infer<typeof listProformasQuerySchema>;

/** Cliente de la proforma, lo minimo para identificarlo en pantalla. */
export interface ProformaClientRef {
  id: string;
  code: string;
  name: string;
}

/**
 * Totales de una proforma en las dos monedas. En una aprobada son los CONGELADOS;
 * en un borrador son una vista previa calculada al pedirla (cada linea con su
 * propia tasa, la misma regla que al aprobar).
 */
export interface ProformaTotals {
  usd: number;
  crc: number;
}

/** Fila del listado. */
export interface ProformaListItem {
  id: string;
  number: string | null;
  status: ProformaStatus;
  flow: Flow;
  currency: Currency;
  client: ProformaClientRef;
  shipmentCount: number;
  totals: ProformaTotals;
  /** Estado de entrega, derivado de sus tramites (ver `proformaDeliveryStatus`). */
  deliveryStatus: ProformaDeliveryStatus;
  createdAt: string;
  approvedAt: string | null;
  paidAt: string | null;
}

/** Un tramite dentro del detalle de la proforma, con sus lineas propias. */
export interface ProformaShipmentDto {
  id: string;
  code: string;
  shipmentType: ShipmentType;
  state: State;
  tracking: string;
  hawb: string | null;
  description: string;
  /** Peso real de bascula (el que se cobra lo decide la tarifa, ver la linea de flete). */
  weightKg: number | null;
  lines: CostLineDto[];
  /** Total de ESTE tramite en la moneda de la proforma. */
  total: number;
}

/** Detalle completo de la proforma. */
export interface ProformaDetailDto extends ProformaListItem {
  /** True mientras es borrador: la pantalla habilita la edicion con esto. */
  editable: boolean;
  /**
   * El borrador que acumula del cliente (Paqueteria): los paquetes que lleguen
   * caen aqui. La pantalla lo marca para que el operador sepa cual es.
   */
  accumulates: boolean;
  /** Suma del peso real de los paquetes, en kilos. Null si ninguno tiene peso. */
  totalWeightKg: number | null;
  shipments: ProformaShipmentDto[];
  /** Servicios adicionales cargados a la proforma entera (no a un paquete). */
  costs: CostLineDto[];
  /**
   * Tasa del documento: la congelada al aprobar o, en un borrador, la vigente del
   * sistema. Null si todavia nadie fijo la tasa.
   */
  exchangeRate: number | null;
  electronicInvoiceNumber: string | null;
  approvedByName: string | null;
}

/** Guardar los servicios adicionales de la proforma: reemplaza el juego completo. */
export const saveProformaCostsSchema = z.object({
  lines: z.array(costLineInputSchema).max(50, 'Demasiadas líneas de costo.'),
});
export type SaveProformaCostsInput = z.infer<typeof saveProformaCostsSchema>;

/**
 * Aprobar en bloque. El tope evita que una seleccion accidental de toda la
 * bandeja numere cientos de proformas de un golpe.
 */
export const approveProformasSchema = z.object({
  ids: z
    .array(z.string().uuid())
    .min(1, 'Elige al menos una proforma.')
    .max(100, 'Se aprueban hasta 100 proformas por vez.'),
});
export type ApproveProformasInput = z.infer<typeof approveProformasSchema>;

/**
 * Resultado de aprobar en bloque. Cada proforma se aprueba en su propia
 * transaccion: una que falla no deshace las demas, y el operador ve cuales
 * salieron y por que no salio el resto.
 */
export interface ApproveProformasResult {
  approved: { id: string; number: string }[];
  failed: { id: string; code: string; message: string }[];
}

/** Corregir una proforma aprobada y no pagada. El motivo queda en el historial. */
export const correctProformaSchema = z.object({
  note: z
    .string()
    .trim()
    .min(3, 'Indica por qué se corrige la proforma.')
    .max(500, 'El motivo es demasiado largo.'),
});
export type CorrectProformaInput = z.infer<typeof correctProformaSchema>;

/**
 * Mover un tramite de un borrador a otro. `toProformaId: null` lo saca a una
 * proforma NUEVA (decision P4); con un id, a otro borrador del mismo cliente,
 * flujo y moneda (asi se agrupan a mano los tramites de Transporte y
 * Agenciamiento).
 */
export const moveProformaShipmentSchema = z.object({
  toProformaId: z.string().uuid().nullable(),
});
export type MoveProformaShipmentInput = z.infer<typeof moveProformaShipmentSchema>;

/** Datos editables de la cabecera: hoy solo el consecutivo de factura electronica. */
export const updateProformaSchema = z.object({
  electronicInvoiceNumber: electronicInvoiceNumberSchema.nullable(),
});
export type UpdateProformaInput = z.infer<typeof updateProformaSchema>;

/** Contador de la serie: el numero que recibira la proxima proforma aprobada. */
export interface ProformaCounterDto {
  nextNumber: number;
  /** El mayor numero ya asignado; null si todavia no se aprobo ninguna. */
  lastIssued: number | null;
}

/** Fijar el arranque de la serie (configuracion previa a produccion). */
export const setProformaCounterSchema = z.object({
  nextNumber: z
    .number({ invalid_type_error: 'Digita un número.' })
    .int('El número debe ser entero.')
    .positive('El número debe ser mayor que cero.')
    .max(2_000_000_000, 'Ese número es demasiado grande.'),
});
export type SetProformaCounterInput = z.infer<typeof setProformaCounterSchema>;

/**
 * Registrar la ENTREGA de una proforma de Paqueteria (una visita del mensajero).
 * Va como campo `payload` (JSON) de un multipart que lleva ademas las fotos.
 *
 *   - `delivered`: paquetes que se entregaron. Con alguno, la visita exige de 1 a
 *     10 fotos (decision P14).
 *   - `returned`: paquetes que se devolvieron a bodega, cada uno con su motivo
 *     (decision P6).
 *   - Los que no aparecen en ninguna lista siguen "En ruta de entrega" y se
 *     confirman despues (regla 13 del SOW).
 */
export const recordProformaDeliverySchema = z
  .object({
    delivered: z.array(z.string().uuid()).max(200),
    returned: z
      .array(
        z.object({
          shipmentId: z.string().uuid(),
          reason: z
            .string()
            .trim()
            .min(3, 'Indica por qué se devolvió el paquete.')
            .max(500, 'El motivo es demasiado largo.'),
        }),
      )
      .max(200),
  })
  .refine((v) => v.delivered.length + v.returned.length > 0, {
    message: 'Marca al menos un paquete entregado o devuelto.',
    path: ['delivered'],
  })
  .refine(
    (v) => {
      const ids = [...v.delivered, ...v.returned.map((r) => r.shipmentId)];
      return new Set(ids).size === ids.length;
    },
    { message: 'Un paquete no puede estar entregado y devuelto a la vez.', path: ['returned'] },
  );
export type RecordProformaDeliveryInput = z.infer<typeof recordProformaDeliverySchema>;
