/**
 * Build de produccion de la API (docs/12 §6.1).
 *
 * Empaqueta con esbuild en vez de compilar con `tsc` por dos razones concretas:
 *
 *  1. `@courier/shared` se distribuye como TS FUENTE del workspace (no tiene
 *     build propio). Un `tsc` de la API dejaria imports a un paquete sin
 *     compilar; el bundler lo resuelve y lo incorpora.
 *  2. El resultado es un solo archivo por entry point, asi que la imagen no
 *     necesita `node_modules` (salvo lo nativo, ver `external`) ni el
 *     transpilador en runtime, que era lo que hacia `tsx`.
 *
 * El typecheck NO vive aqui: sigue siendo `pnpm typecheck` (tsc --noEmit).
 * esbuild borra los tipos sin comprobarlos, a proposito: son dos trabajos
 * distintos y mezclarlos solo hace el build mas lento.
 */
import { build } from 'esbuild';

/**
 * Modulos que NO se pueden empaquetar y quedan como dependencia real de la
 * imagen. `@node-rs/argon2` es un binario nativo (.node): esbuild no lo puede
 * meter en un bundle de JavaScript, asi que se instala aparte en el Dockerfile.
 */
const external = ['@node-rs/argon2'];

/**
 * El bundle es ESM, pero alguna dependencia transitiva sigue siendo CommonJS y
 * espera encontrar `require`, `__filename` o `__dirname` en el ambito del
 * modulo. En ESM no existen; este preambulo los reconstruye.
 */
const banner = {
  js: [
    "import { createRequire as __createRequire } from 'node:module';",
    "import { fileURLToPath as __fileURLToPath } from 'node:url';",
    "import { dirname as __dirname_of } from 'node:path';",
    'const require = __createRequire(import.meta.url);',
    'const __filename = __fileURLToPath(import.meta.url);',
    'const __dirname = __dirname_of(__filename);',
  ].join('\n'),
};

await build({
  /**
   * Tres entry points, no uno: la imagen tiene que poder hacer tres cosas con el
   * mismo codigo. `main` es el servidor, `migrate` es el paso de migraciones del
   * despliegue y `seed` siembra el primer administrador, que no puede
   * autoregistrarse ni recibir invitacion (ver `src/seed.ts`). Los otros seeds
   * son de desarrollo y no entran.
   */
  entryPoints: ['src/main.ts', 'src/migrate.ts', 'src/seed.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Mapa de fuentes aparte: los stack traces de produccion apuntan al TS
  // original sin inflar el archivo que se carga en cada arranque.
  sourcemap: 'linked',
  minify: false,
  logLevel: 'info',
  external,
  banner,
});
