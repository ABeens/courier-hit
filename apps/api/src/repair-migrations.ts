/**
 * Reparador del control de migraciones cuando la BASE va ADELANTADA respecto a
 * `drizzle.__drizzle_migrations`.
 *
 * Sintoma tipico:
 *
 *   PostgresError: relation "hs_proforma_number_seq" already exists
 *
 * `drizzle-kit migrate` no compara el esquema real: mira la ultima fila de
 * `drizzle.__drizzle_migrations` y aplica TODA entrada del journal cuyo `when`
 * sea mayor. Si los objetos de una migracion ya estan en la base pero su fila
 * no se escribio nunca, la vuelve a aplicar y choca con lo que ya existe.
 *
 * Como se llega ahi: casi siempre por un `db:push`, que empuja el esquema sin
 * dejar rastro en la tabla de control (README, "solo para prototipar"). Tambien
 * pasa si alguien corrio el .sql a mano o si una migracion se corto a medias.
 *
 * Que hace este script: recorre las migraciones pendientes statement por
 * statement y solo ejecuta las que faltan. Los statements que fallan porque el
 * objeto YA existe (o porque un DROP ya no lo encuentra) se saltan, se muestran
 * con su codigo de error, y al final la migracion queda anotada en la tabla de
 * control con el mismo hash y `created_at` que habria escrito drizzle. Despues
 * de esto `db:migrate` vuelve a funcionar normal.
 *
 * Cualquier otro error aborta: no se anota nada y la transaccion se deshace.
 *
 * Uso:
 *   pnpm --filter @courier/api db:repair              # solo informa (no toca nada)
 *   pnpm --filter @courier/api db:repair -- --apply   # repara de verdad
 *
 * Es para bases de DESARROLLO. En el servidor las migraciones las corre el
 * contenedor de un uso (`migrate.ts`, docs/12 §6.3) y la tabla de control nunca
 * se queda atras porque ahi no se usa `db:push`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[repair] Falta DATABASE_URL (sale de apps/api/.env).');
  process.exit(1);
}

const apply = process.argv.includes('--apply');

/** Misma carpeta que usa drizzle-kit: `out` del drizzle.config.ts. */
const migrationsFolder = process.env.MIGRATIONS_DIR ?? './drizzle';

type JournalEntry = { idx: number; when: number; tag: string };

/**
 * Errores que este script considera "esto ya estaba resuelto" y puede saltar.
 * Son los dos lados de la misma moneda: crear algo que ya existe, o borrar algo
 * que ya no esta.
 */
const ALREADY_SETTLED: Record<string, string> = {
  '42P06': 'el schema ya existe',
  '42P07': 'la tabla, indice o secuencia ya existe',
  '42701': 'la columna ya existe',
  '42710': 'el objeto ya existe (constraint, tipo, indice)',
  '42723': 'la funcion ya existe',
  '42P01': 'la tabla ya no existe',
  '42703': 'la columna ya no existe',
  '42704': 'el objeto ya no existe',
};

/** El hash es el sha256 del .sql completo, igual que en drizzle-orm/migrator. */
function readMigration(entry: JournalEntry) {
  const path = resolve(migrationsFolder, `${entry.tag}.sql`);
  const query = readFileSync(path, 'utf8');
  return {
    ...entry,
    hash: createHash('sha256').update(query).digest('hex'),
    statements: query
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

const journalPath = resolve(migrationsFolder, 'meta/_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };

// Una sola conexion: el proceso muere al terminar y no hay concurrencia.
const client = postgres(url, { max: 1, onnotice: () => {} });

/** Sentinela para deshacer la transaccion en el modo informativo. */
class DryRun extends Error {}

try {
  // La tabla de control puede no existir todavia (base recien creada). Se crea
  // con la misma forma que usa drizzle para no dejarle una distinta.
  await client.unsafe('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.unsafe(`CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  )`);

  const [last] = await client.unsafe<{ created_at: string | null }[]>(
    'SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
  );
  const lastApplied = last?.created_at ? Number(last.created_at) : 0;

  const lastTag = journal.entries.find((e) => e.when === lastApplied)?.tag;
  console.log(
    lastApplied === 0
      ? '[repair] La base no tiene ninguna migracion anotada.'
      : `[repair] Ultima migracion anotada: ${lastTag ?? '(no esta en el journal)'} (created_at ${lastApplied}).`,
  );

  const pending = journal.entries.filter((e) => e.when > lastApplied).map(readMigration);

  if (pending.length === 0) {
    console.log('[repair] No hay migraciones pendientes. Nada que reparar.');
  } else {
    console.log(`[repair] Pendientes: ${pending.map((p) => p.tag).join(', ')}`);
    console.log(
      apply
        ? '[repair] Modo --apply: se ejecuta lo que falte y se anota cada migracion.\n'
        : '[repair] Modo informativo: se prueba todo y se DESHACE al final. Nada se guarda.\n',
    );

    await client.begin(async (tx) => {
      for (const migration of pending) {
        console.log(`  ${migration.tag}`);
        let executed = 0;
        let skipped = 0;

        for (const statement of migration.statements) {
          try {
            // Savepoint: si el statement falla, se deshace solo ese y la
            // transaccion sigue viva para el siguiente.
            await tx.savepoint(async (sp) => {
              await sp.unsafe(statement);
            });
            executed += 1;
          } catch (error) {
            const code = (error as { code?: string }).code ?? '';
            const reason = ALREADY_SETTLED[code];
            if (!reason) throw error;
            skipped += 1;
            const head = statement.replace(/\s+/g, ' ').slice(0, 90);
            console.log(`    - salta (${code}, ${reason}): ${head}`);
          }
        }

        await tx.unsafe(
          'INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)',
          [migration.hash, migration.when],
        );
        console.log(`    ${executed} statement(s) aplicados, ${skipped} saltados. Anotada.`);
      }

      if (!apply) throw new DryRun();
    });

    console.log('\n[repair] Listo. Corre `pnpm --filter @courier/api db:migrate` para confirmar.');
  }
} catch (error) {
  if (error instanceof DryRun) {
    console.log('\n[repair] Prueba deshecha: la base quedo igual que estaba.');
    console.log('[repair] Si lo de arriba tiene sentido, repite con:');
    console.log('           pnpm --filter @courier/api db:repair -- --apply');
  } else {
    console.error('\n[repair] Error que NO es "ya existe". No se anoto nada:');
    console.error(error);
    console.error(
      '[repair] La base no quedo a medias (se deshizo todo), pero el desajuste sigue.\n' +
        '         Si es una base de desarrollo desechable, sale mas barato recrearla:\n' +
        '         borrar la base, db:migrate y db:seed (docs/seeds.md §1).',
    );
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
