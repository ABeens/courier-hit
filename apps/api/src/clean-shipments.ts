/**
 * BORRA TODOS LOS TRAMITES y lo que cuelga de ellos. Es irreversible.
 *
 * Para que existe: dejar la base limpia de trámites antes de arrancar en serio,
 * sin tocar lo que cuesta volver a montar (usuarios, casilleros, tarifas, rutas,
 * servicios de costo, configuración). Lo que se va es el movimiento; lo que se
 * queda es el catálogo.
 *
 * Se ejecuta con el MISMO codigo en las dos partes (local y AWS) a proposito: la
 * lista de tablas y la de adjuntos no se pueden mantener en dos sitios sin que
 * uno se quede viejo, y el que se quede viejo deja basura que nadie vuelve a
 * mirar. El script de PowerShell (`scripts/limpiar-tramites.ps1`) solo decide
 * DONDE corre esto, no QUE borra.
 *
 * Los adjuntos se borran por CLAVE, leyendola de la base antes de vaciarla, y no
 * arrasando los prefijos del bucket: asi se borra exactamente lo que pertenecia a
 * un tramite y cualquier otra cosa que viva ahi se queda donde esta.
 *
 * Variables: DATABASE_URL (obligatoria) y las de almacenamiento que ya usa la
 * API. Con CLEAN_DRY_RUN=1 solo cuenta y no borra nada.
 */
import { sql } from 'drizzle-orm';
import { db } from './core/db';
import { storage } from './core/storage';

const DRY_RUN = process.env.CLEAN_DRY_RUN === '1';

/**
 * Tablas que se vacian, en orden de dependencia. `shipments` arrastra por
 * cascada sus eventos, costos, pagos e intentos de entrega, pero se cuentan
 * aparte para que el resumen diga la verdad de lo que se llevo por delante.
 *
 * `payment_groups` NO cuelga de `shipments` (es del casillero), asi que se borra
 * a mano: si se dejara, quedarian cobros agrupados apuntando a paquetes que ya
 * no existen.
 */
const COUNTED = [
  'shipments',
  'shipment_events',
  'shipment_costs',
  'delivery_attempts',
  'payments',
  'payment_groups',
  'proforma_numbers',
] as const;

/** Consecutivos que vuelven a empezar. El de CASILLEROS no se toca. */
const SEQUENCES = ['hs_shipment_code_seq', 'hs_proforma_number_seq'] as const;

async function countRows(table: string): Promise<number> {
  const rows = (await db.execute(
    sql.raw(`select count(*)::text as n from ${table}`),
  )) as Array<{ n: string }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Claves de adjunto vivas: documentos de tramite, fotos de entrega, comprobantes.
 *
 * Las fotos van en un ARRAY (`photo_file_keys`): un intento de entrega puede
 * llevar hasta tres. Se abre con `unnest` para que cada foto sea una clave
 * suelta; un array vacio no aporta filas, que es lo que se quiere.
 */
async function attachmentKeys(): Promise<string[]> {
  const rows = (await db.execute(
    sql.raw(`
      select document_file_key as key from shipments where document_file_key is not null
      union all
      select unnest(photo_file_keys) as key from delivery_attempts
      union all
      select receipt_file_key as key from payments where receipt_file_key is not null
    `),
  )) as Array<{ key: string }>;
  return rows.map((r) => r.key).filter(Boolean);
}

async function main() {
  const before: Record<string, number> = {};
  for (const table of COUNTED) before[table] = await countRows(table);
  const keys = await attachmentKeys();

  console.log(DRY_RUN ? '\n[simulacion] esto es lo que se borraria:\n' : '\nSe va a borrar:\n');
  for (const table of COUNTED) console.log(`  ${table.padEnd(20)} ${before[table]}`);
  console.log(`  ${'adjuntos'.padEnd(20)} ${keys.length}`);

  if (DRY_RUN) {
    console.log('\n[simulación] no se tocó nada.');
    return;
  }

  /**
   * Los archivos PRIMERO y la base despues. Al reves, un fallo a media limpieza
   * dejaria archivos cuyas claves ya no estan en ninguna fila: basura que nadie
   * puede volver a encontrar ni relacionar con nada. En este orden, un fallo deja
   * archivos de menos y filas de mas, que es visible y se puede volver a correr.
   */
  let removed = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      await storage.remove(key);
      removed++;
    } catch {
      // Un adjunto que ya no esta (borrado a mano, o una limpieza a medias que se
      // reintenta) no puede abortar el resto: se cuenta y se sigue.
      failed++;
    }
  }
  console.log(`\nadjuntos borrados: ${removed}${failed > 0 ? ` (${failed} no se pudieron borrar)` : ''}`);

  await db.transaction(async (tx) => {
    // El orden importa: `proforma_numbers` apunta a las dos tablas de abajo.
    await tx.execute(sql.raw('delete from proforma_numbers'));
    await tx.execute(sql.raw('delete from payment_groups'));
    await tx.execute(sql.raw('delete from shipments'));
    for (const seq of SEQUENCES) {
      await tx.execute(sql.raw(`alter sequence ${seq} restart with 1000`));
    }
  });

  const after: Record<string, number> = {};
  for (const table of COUNTED) after[table] = await countRows(table);
  const left = Object.entries(after).filter(([, n]) => n > 0);

  console.log('\ntablas vaciadas y consecutivos de trámite y proforma de vuelta en 1000.');
  if (left.length > 0) {
    console.error('QUEDARON FILAS:', left.map(([t, n]) => `${t}=${n}`).join(', '));
    process.exit(1);
  }
  console.log('listo.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[limpiar] falló:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
