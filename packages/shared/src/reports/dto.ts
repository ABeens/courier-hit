/**
 * Esquemas Zod del modulo de reportes.
 *
 * Los filtros son los mismos del dashboard de tramites (rango de fechas, tipo,
 * cliente) porque un reporte ES el dashboard exportado: si divergieran, el
 * usuario veria una cosa en pantalla y otra en el CSV.
 */
import { z } from 'zod';
import { ShipmentType } from '../workflow/shipment-type';
import { ReportKind } from './report';

/** Instante en UTC (ISO 8601). Misma convencion que el resto de la API. */
const instantSchema = z.string().datetime({ offset: true, message: 'Fecha inválida.' });

export const reportQuerySchema = z.object({
  kind: z.nativeEnum(ReportKind, {
    errorMap: () => ({ message: 'Elige un reporte válido.' }),
  }),
  from: instantSchema.optional(),
  to: instantSchema.optional(),
  clientId: z.string().uuid().optional(),
  shipmentType: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(z.nativeEnum(ShipmentType)).nonempty().optional()),
  /** `csv` descarga el archivo; sin esto la respuesta es JSON para la tabla. */
  format: z.enum(['json', 'csv']).default('json'),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;
