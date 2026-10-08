/**
 * VACIA LA BASE ENTERA. Es irreversible.
 *
 * A diferencia de `clean-shipments.ts`, que solo se lleva el movimiento, esto se
 * lleva TODO lo que vive en el esquema `public`: usuarios, casilleros, tarifas,
 * rutas, servicios de costo, configuracion, claves de API, tramites, pagos y
 * proformas. Tambien devuelve cada consecutivo a su valor inicial y borra los
 * adjuntos. Lo unico que queda es el historial de migraciones (vive en el
 * esquema `drizzle`), asi que el esquema sigue al dia y no hay que migrar.
 *
 * Despues hay que sembrar el administrador (`seed.ts`): sin el nadie puede
 * entrar. `scripts/reset-db.ps1` hace las dos cosas seguidas.
 *
 * La lista de tablas, consecutivos y columnas de adjuntos se lee del catalogo de
 * Postgres, no de una lista escrita a mano: una tabla nueva queda cubierta sin
 * tocar este archivo.
 *
 * Variables: DATABASE_URL y las de almacenamiento que ya usa la API.
 *   RESET_DB_DRY_RUN=1  solo cuenta, no borra.
 *   RESET_DB_CONFIRM=1  obligatoria para borrar: que un `pnpm db:reset` suelto
 *                       no pueda vaciar la base por despiste.
 */
import { sql } from 'drizzle-orm';
import { db } from './core/db';
import { storage } from './core/storage';

const DRY_RUN = process.env.RESET_DB_DRY_RUN === '1';
const CONFIRMED = process.env.RESET_DB_CONFIRM === '1';

/** Identificador entre comillas dobles, para nombres que vienen del catalogo. */
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function tables(): Promise<string[]> {
  const rows = (await db.execute(
    sql.raw(`select tablename from pg_tables where schemaname = 'public' and tablename not like '\\_\\_drizzle%' order by tablename`),
  )) as Array<{ tablename: string }>;
  return rows.map((r) => r.tablename);
}

async function sequences(): Promise<string[]> {
  const rows = (await db.execute(
    sql.raw(`select sequencename from pg_sequences where schemaname = 'public' order by sequencename`),
  )) as Array<{ sequencename: string }>;
  return rows.map((r) => r.sequencename);
}

async function countRows(table: string): Promise<number> {
  const rows = (await db.execute(sql.raw(`select count(*)::text as n from ${ident(table)}`))) as Array<{ n: string }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Claves de adjunto vivas en cualquier tabla: toda columna `*_file_key` (texto)
 * o `*_file_keys` (array). Se borran por clave, como en `clean-shipments.ts`,
 * para no arrasar prefijos del bucket que no son nuestros.
 */
async function attachmentKeys(): Promise<string[]> {
  const columns = (await db.execute(
    sql.raw(`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public' and (column_name like '%file\\_key' or column_name like '%file\\_keys')
    `),
  )) as Array<{ table_name: string; column_name: string; data_type: string }>;

  const keys = new Set<string>();
  for (const c of columns) {
    const expr = c.data_type === 'ARRAY' ? `unnest(${ident(c.column_name)})` : ident(c.column_name);
    const rows = (await db.execute(
      sql.raw(`select ${expr} as key from ${ident(c.table_name)} where ${ident(c.column_name)} is not null`),
    )) as Array<{ key: string | null }>;
    for (const r of rows) if (r.key) keys.add(r.key);
  }
  return [...keys];
}

async function main() {
  const all = await tables();
  const seqs = await sequences();
  const keys = await attachmentKeys();

  console.log(DRY_RUN ? '\n[simulacion] esto es lo que se borraria:\n' : '\nSe va a borrar:\n');
  let total = 0;
  for (const table of all) {
    const n = await countRows(table);
    total += n;
    if (n > 0) console.log(`  ${table.padEnd(28)} ${n}`);
  }
  console.log(`  ${'(filas en total)'.padEnd(28)} ${total} en ${all.length} tablas`);
  console.log(`  ${'adjuntos'.padEnd(28)} ${keys.length}`);
  console.log(`  ${'consecutivos a reiniciar'.padEnd(28)} ${seqs.join(', ') || '(ninguno)'}`);

  if (DRY_RUN) {
    console.log('\n[simulacion] no se toco nada.');
    return;
  }
  if (!CONFIRMED) {
    throw new Error('falta RESET_DB_CONFIRM=1. Usa scripts/reset-db.ps1, que pide confirmacion antes.');
  }

  // Archivos primero, base despues: un fallo a medias deja filas de mas (se ve y
  // se reintenta), nunca archivos huerfanos cuya clave ya no esta en ninguna fila.
  let removed = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      await storage.remove(key);
      removed++;
    } catch {
      failed++;
    }
  }
  console.log(`\nadjuntos borrados: ${removed}${failed > 0 ? ` (${failed} no se pudieron borrar)` : ''}`);

  await db.transaction(async (tx) => {
    if (all.length > 0) {
      await tx.execute(sql.raw(`truncate table ${all.map(ident).join(', ')} restart identity cascade`));
    }
    // RESTART sin valor vuelve al START WITH de cada consecutivo (casilleros,
    // tramites, proformas), que es con el que nacio en su migracion.
    for (const seq of seqs) await tx.execute(sql.raw(`alter sequence ${ident(seq)} restart`));
  });

  let left = 0;
  for (const table of all) left += await countRows(table);
  if (left > 0) {
    console.error(`QUEDARON ${left} FILAS.`);
    process.exit(1);
  }
  console.log('base vacia y consecutivos reiniciados. Falta sembrar el administrador (seed.ts).');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[reset-db] fallo:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
