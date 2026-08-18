/**
 * Migraciones como paso del despliegue (docs/12 §6.3).
 *
 * En desarrollo se usa `drizzle-kit migrate`, que necesita el CLI, el TypeScript
 * del esquema y el `drizzle.config.ts`. En el servidor no hay nada de eso: solo
 * el bundle y la carpeta `drizzle/`. Este entry point aplica exactamente las
 * mismas migraciones (mismo journal, misma tabla de control) sin depender del
 * CLI, y se ejecuta como un contenedor de un solo uso antes de arrancar la API.
 *
 * NO importa `core/config` a proposito: una migracion solo necesita la base. Si
 * pidiera la configuracion completa, un despliegue no podria migrar hasta tener
 * cargadas las credenciales de Helga o de la pasarela, que no tienen nada que
 * ver con el esquema.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] Falta DATABASE_URL.');
  process.exit(1);
}

/** Carpeta con el journal y los .sql. Junto al bundle en la imagen. */
const migrationsFolder = process.env.MIGRATIONS_DIR ?? './drizzle';

// Una sola conexion: no hay concurrencia que aprovechar y el proceso muere al
// terminar. `max: 1` evita ademas que el pool deje sockets abiertos.
const client = postgres(url, { max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder });
  console.log('[migrate] Migraciones aplicadas.');
} catch (error) {
  console.error('[migrate] Fallo al aplicar migraciones:', error);
  process.exitCode = 1;
} finally {
  await client.end();
}
