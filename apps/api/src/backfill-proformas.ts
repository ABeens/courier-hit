/**
 * Pone en proformas los tramites que quedaron fuera del modulo: los facturados
 * sin proforma y los que estan en "Facturacion en proceso" sin borrador (por
 * ejemplo, corregidos de estado antes de que la correccion armara el borrador).
 * Ver `modules/proformas/proforma-backfill.ts`.
 *
 * Idempotente: solo toca tramites que no estan en ninguna proforma.
 *
 * Con BACKFILL_DRY_RUN=1 solo cuenta y no escribe nada. En la nube corre dentro
 * de la instancia, con la imagen de la API: scripts/backfill-proformas.ps1.
 *
 * Uso: pnpm --filter @courier/api db:backfill-proformas
 */
import { backfillProformas } from './modules/proformas/proforma-backfill';

const dryRun = process.env.BACKFILL_DRY_RUN === '1';

backfillProformas({ dryRun })
  .then((r) => {
    if (dryRun) {
      console.log(`[proformas] SIMULACION: se aprobarían ${r.approved} proformas y ${r.drafts} trámites irían a borrador. No se escribió nada.`);
    } else {
      console.log(`[proformas] ${r.approved} proformas aprobadas y ${r.drafts} trámites puestos en borrador.`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('[proformas] error:', err);
    process.exit(1);
  });
