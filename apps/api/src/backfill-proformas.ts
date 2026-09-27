/**
 * Pone en proformas los tramites que quedaron fuera del modulo: los facturados
 * sin proforma y los que estan en "Facturacion en proceso" sin borrador (por
 * ejemplo, corregidos de estado antes de que la correccion armara el borrador).
 * Ver `modules/proformas/proforma-backfill.ts`.
 *
 * Idempotente: solo toca tramites que no estan en ninguna proforma.
 *
 * Uso: pnpm --filter @courier/api db:backfill-proformas
 */
import { backfillProformas } from './modules/proformas/proforma-backfill';

backfillProformas()
  .then((r) => {
    console.log(`[proformas] ${r.approved} proformas aprobadas y ${r.drafts} trámites puestos en borrador.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[proformas] error:', err);
    process.exit(1);
  });
