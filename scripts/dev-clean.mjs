/**
 * Limpieza previa al arranque de los servidores de desarrollo.
 *
 * En Windows, `Ctrl+C` sobre `pnpm -r --parallel dev` mata el proceso padre pero
 * no siempre el arbol de hijos (`tsx watch` -> `node`, `astro dev`). Los restos
 * se quedan pegados al puerto y la siguiente corrida falla con EADDRINUSE, o
 * Astro encuentra su `dev.json` con un PID que el sistema operativo ya reciclo
 * y aborta con "Another astro dev server is already running".
 *
 * Este script libera los puertos de dev y borra el lock de Astro antes de
 * levantar todo. Es idempotente: si no hay nada que limpiar, no hace nada.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

/** Compara rutas sin pelear con el separador de cada sistema operativo. */
const normalize = (value) => value.split('\\').join('/').toLowerCase();
const ROOT_KEY = normalize(ROOT);

/** El puerto de la API sale de su .env; Astro usa 4321 salvo configuracion. */
function apiPort() {
  const envPath = resolve(ROOT, 'apps/api/.env');
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m);
    if (match) return Number(match[1]);
  }
  return 3001;
}

const PORTS = [
  { port: apiPort(), label: 'api' },
  { port: 4321, label: 'web' },
];

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function sh(command) {
  return execFileSync('/bin/sh', ['-c', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** `ConvertTo-Json` devuelve objeto suelto cuando hay un solo elemento. */
function parseJsonList(raw) {
  const text = raw.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const toProc = (row) => ({
  pid: row.ProcessId,
  name: row.Name ?? '',
  cmd: row.CommandLine ?? '',
});

/** Procesos que escuchan en `port`, con nombre y linea de comando. */
function listenersOn(port) {
  try {
    if (isWindows) {
      const raw = powershell(
        `$owners = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
          `Select-Object -ExpandProperty OwningProcess -Unique); ` +
          `if (-not $owners) { '' } else { ` +
          `@($owners | ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue }) | ` +
          `Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Depth 3 -Compress }`,
      );
      return parseJsonList(raw).map(toProc);
    }
    const pids = sh(`lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null || true`)
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter(Boolean);
    return [...new Set(pids)].map((pid) => ({
      pid,
      name: sh(`ps -p ${pid} -o comm= 2>/dev/null || true`).trim(),
      cmd: sh(`ps -p ${pid} -o args= 2>/dev/null || true`).trim(),
    }));
  } catch {
    return [];
  }
}

/**
 * Restos de `tsx watch` / `astro dev` de este repo que siguen vivos aunque su
 * hijo ya murio. No retienen puerto, pero al primer cambio de archivo lo
 * vuelven a tomar y pisan la corrida nueva.
 */
function orphanWatchers(skipPids) {
  const isOurWatcher = (proc) => {
    const cmd = normalize(proc.cmd);
    if (!cmd.includes(ROOT_KEY)) return false;
    if (skipPids.has(proc.pid) || proc.pid === process.pid) return false;
    return cmd.includes('tsx') || cmd.includes('astro');
  };
  try {
    if (isWindows) {
      const raw = powershell(
        `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue) | ` +
          `Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Depth 3 -Compress`,
      );
      return parseJsonList(raw).map(toProc).filter(isOurWatcher);
    }
    return sh('ps -eo pid=,args= 2>/dev/null || true')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(' ');
        return { pid: Number(line.slice(0, space)), name: 'node', cmd: line.slice(space + 1) };
      })
      .filter(isOurWatcher);
  } catch {
    return [];
  }
}

function killTree(pid) {
  try {
    if (isWindows) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

/** Solo matamos procesos de Node: si el puerto lo tiene otra app, avisamos. */
function isNode(proc) {
  return /^node(\.exe)?$/i.test(proc.name.trim()) || /(^|[\\/])node(\.exe)?["']?\s/i.test(proc.cmd);
}

const killed = [];
const skipped = [];
const handledPids = new Set();

for (const { port, label } of PORTS) {
  for (const proc of listenersOn(port)) {
    handledPids.add(proc.pid);
    if (!isNode(proc)) {
      skipped.push({ ...proc, port, label });
      continue;
    }
    if (killTree(proc.pid)) killed.push({ ...proc, reason: `puerto ${port} (${label})` });
  }
}

for (const proc of orphanWatchers(handledPids)) {
  if (killTree(proc.pid)) killed.push({ ...proc, reason: 'watcher huerfano' });
}

// Astro no borra su lock cuando lo matan; si queda, la proxima corrida aborta.
const astroLock = resolve(ROOT, 'apps/web/.astro/dev.json');
let lockRemoved = false;
if (existsSync(astroLock)) {
  rmSync(astroLock, { force: true });
  lockRemoved = true;
}

for (const proc of killed) {
  console.log(`[dev-clean] terminado PID ${proc.pid}: ${proc.reason}`);
}
for (const proc of skipped) {
  console.warn(
    `[dev-clean] el puerto ${proc.port} (${proc.label}) lo tiene "${proc.name}" (PID ${proc.pid}), ` +
      'que no es Node. No lo toco: libera ese puerto a mano o cambia el puerto de dev.',
  );
}
if (lockRemoved) {
  console.log('[dev-clean] lock de Astro (apps/web/.astro/dev.json) eliminado');
}
if (!killed.length && !skipped.length && !lockRemoved) {
  console.log('[dev-clean] sin restos de corridas anteriores');
}
