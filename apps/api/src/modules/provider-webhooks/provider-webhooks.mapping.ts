/**
 * Lectura de los cuerpos que manda Helga (especificacion v1.0, §5 y §6).
 *
 * LO MINIMO SE EXIGE, LO DEMAS SE TOLERA. Un aviso solo se rechaza si no se
 * puede leer (SOW, reglas de negocio): un rechazo hace que Helga detenga los
 * avisos siguientes del paquete hasta una revision manual. Por eso aqui solo son
 * obligatorias las llaves sin las que no hay nada que hacer (`code`;
 * `evento_id` + `paquete.hawb` + `estado_de_guia.descripcion`). Un peso ilegible,
 * un `consignee` ausente o un campo nuevo no tumban el aviso: se leen como
 * `null` o se ignoran.
 */
import { z } from 'zod';

/** Texto no vacio, recortado. Acepta numeros (Helga no es estricta con tipos). */
const requiredText = z.preprocess(
  (v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : v),
  z.string().min(1),
);

/** Cuerpo minimo de la creacion de paquete. El resto se lee con `readPackage`. */
export const packageEnvelopeSchema = z
  .object({ code: requiredText })
  .passthrough();

/** Cuerpo minimo del tracking. */
export const trackingEnvelopeSchema = z
  .object({
    evento_id: z.preprocess(
      (v) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v),
      z.number().int().nonnegative(),
    ),
    paquete: z.object({ hawb: requiredText }).passthrough(),
    estado_de_guia: z.object({ descripcion: requiredText }).passthrough(),
  })
  .passthrough();

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function text(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** Numero decimal que puede venir como texto ("4.50"). Ilegible = null. */
function decimal(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Medida: solo si es positiva. El 0 de Helga es "no medido", no "mide cero". */
function positive(v: unknown): number | null {
  const n = decimal(v);
  return n !== null && n > 0 ? n : null;
}

/**
 * DONDE VIENE EL SUBCASILLERO (duda D1 del plan). Helga se comprometio a agregar
 * el campo pero no dijo su nombre. Se prueban estas rutas en orden; cuando Helga
 * lo confirme, se deja solo la buena.
 */
const SUB_LOCKER_PATHS: ReadonlyArray<readonly string[]> = [
  ['shipper', 'sub_casillero'],
  ['shipper', 'subcasillero'],
  ['shipper', 'sub_code'],
  ['sub_casillero'],
  ['subcasillero'],
];

function pick(root: Json, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    const o = obj(cur);
    if (!o) return undefined;
    cur = o[key];
  }
  return cur;
}

/** Lo que la plataforma usa de una creacion de paquete. */
export interface WebhookPackage {
  /** HAWB (`code`). */
  hawb: string;
  /** Casillero que informa Helga (`shipper.code`). Solo se compara, no decide. */
  shipperCode: string | null;
  /** Subcasillero del cliente, cuando Helga lo mande. */
  subLocker: string | null;
  /** Tracking de la transportadora (`package_notes`). */
  carrierTracking: string | null;
  description: string | null;
  weightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  declaredValueUsd: number | null;
}

/**
 * Extrae los campos utiles. La especificacion dice que `commodities` siempre trae
 * UN elemento (cantidad siempre 1); se usa el primero.
 *
 * El peso va en KILOGRAMOS (`weight_kg_received`), como fija el SOW. Las libras
 * (`weight_received`) no se convierten: si el kg no viene, el peso queda sin
 * dato y lo completa la sincronizacion por la op. B.
 *
 * Las fechas de Helga (`operation_datetime`) no se usan. Los datos de contacto de
 * `shipper` y `consignee` tampoco: el contacto real del cliente es el nuestro.
 */
export function readPackage(body: Json): WebhookPackage {
  const shipper = obj(body.shipper);
  const commodities = Array.isArray(body.commodities) ? body.commodities : [];
  const first = obj(commodities[0]) ?? {};

  let subLocker: string | null = null;
  for (const path of SUB_LOCKER_PATHS) {
    subLocker = text(pick(body, path));
    if (subLocker) break;
  }

  return {
    hawb: text(body.code)!,
    shipperCode: text(shipper?.code),
    subLocker,
    carrierTracking: text(first.package_notes),
    description: text(first.description),
    weightKg: positive(first.weight_kg_received),
    lengthCm: positive(first.length_received),
    widthCm: positive(first.width_received),
    heightCm: positive(first.height_received),
    declaredValueUsd: decimal(first.declared_value),
  };
}

/** Lo que la plataforma usa de un tracking. */
export interface WebhookTracking {
  eventId: string;
  hawb: string;
  providerState: string;
}

export function readTracking(body: Json): WebhookTracking {
  const parsed = trackingEnvelopeSchema.parse(body);
  return {
    eventId: String(parsed.evento_id),
    hawb: parsed.paquete.hawb as string,
    providerState: parsed.estado_de_guia.descripcion as string,
  };
}
