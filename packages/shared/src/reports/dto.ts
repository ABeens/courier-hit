/**
 * Esquemas Zod del modulo de reportes.
 *
 * Los filtros son los mismos del dashboard de tramites (rango de fechas, tipo,
 * cliente) porque un reporte ES el dashboard exportado: si divergieran, el
 * usuario veria una cosa en pantalla y otra en el Excel.
 */
import { z } from 'zod';
import { ShipmentType } from '../workflow/shipment-type';
import { ReportKind } from './report';

/** Instante en UTC (ISO 8601). Misma convencion que el resto de la API. */
const instantSchema = z.string().datetime({ offset: true, message: 'Fecha inválida.' });

/**
 * Rango maximo de un reporte, en meses de calendario entre `from` y `to`. Un
 * reporte sin tope recorre la base entera y el Excel deja de abrirse; seis meses
 * cubren un semestre de cierre.
 */
export const REPORT_MAX_RANGE_MONTHS = 6;

/**
 * Suma meses de calendario a un instante, en UTC. Si el dia no existe en el mes
 * destino (31 de agosto + 6 = 31 de febrero) se queda en el ultimo dia de ese
 * mes, en vez de desbordar a marzo como haria `setUTCMonth`.
 */
export function addUtcMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * Filtros de alcance del reporte: rango de fechas, cliente y tipo de tramite.
 * El rango es OBLIGATORIO (ver `REPORT_MAX_RANGE_MONTHS`); `to` es exclusivo.
 */
const scopeFields = {
  from: instantSchema,
  to: instantSchema,
  clientId: z.string().uuid().optional(),
  shipmentType: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(z.nativeEnum(ShipmentType)).nonempty().optional()),
};

export const reportQuerySchema = z
  .object({
    kind: z.nativeEnum(ReportKind, {
      errorMap: () => ({ message: 'Elige un reporte válido.' }),
    }),
    ...scopeFields,
    /** `xlsx` descarga el archivo; sin esto la respuesta es JSON para la tabla. */
    format: z.enum(['json', 'xlsx']).default('json'),
  })
  .refine((q) => new Date(q.from) < new Date(q.to), {
    message: 'La fecha "Desde" debe ser anterior a "Hasta".',
    path: ['to'],
  })
  .refine((q) => new Date(q.to) <= addUtcMonths(new Date(q.from), REPORT_MAX_RANGE_MONTHS), {
    message: `El rango de fechas no puede superar ${REPORT_MAX_RANGE_MONTHS} meses.`,
    path: ['to'],
  });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

