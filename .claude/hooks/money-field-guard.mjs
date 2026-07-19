#!/usr/bin/env node
/**
 * PostToolUse hook: detecta cuando una edicion (Edit/Write/MultiEdit) toca un campo
 * de monto y le pide a Claude que ejecute el subagente `money-rules-reviewer`.
 *
 * Es intencionalmente "tonto": solo detecta por patron y avisa. El razonamiento
 * (verificar M1..M6) lo hace el subagente. Nunca bloquea la edicion; solo inyecta
 * contexto para que se dispare la revision.
 *
 * Configuracion en .claude/money-rules.config.json (seccion "detection").
 */
import { readFileSync } from 'node:fs';

const CONFIG_URL = new URL('../money-rules.config.json', import.meta.url);

/** Lee stdin completo (JSON del hook). */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Sale sin hacer nada (edicion no relevante o error). Nunca rompe el flujo. */
function passThrough() {
  process.exit(0);
}

function main() {
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
  } catch {
    return passThrough(); // sin config, no molestamos
  }

  const detection = config.detection || {};
  const filePatterns = (detection.filePatterns || []).map((p) => new RegExp(p, 'i'));
  const moneyPatterns = (detection.moneyPatterns || []).map((p) => new RegExp(p, 'i'));
  const ignorePaths = detection.ignorePaths || [];

  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return passThrough();
  }

  const toolName = payload.tool_name || '';
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) return passThrough();

  const input = payload.tool_input || {};
  const filePath = (input.file_path || '').replace(/\\/g, '/');
  if (!filePath) return passThrough();

  // Rutas ignoradas (backup, dist, etc.)
  if (ignorePaths.some((frag) => filePath.includes(frag))) return passThrough();

  // Solo archivos de codigo relevantes.
  if (filePatterns.length && !filePatterns.some((re) => re.test(filePath))) return passThrough();

  // Texto que introdujo la edicion.
  let changed = '';
  if (typeof input.content === 'string') changed += input.content;
  if (typeof input.new_string === 'string') changed += '\n' + input.new_string;
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (e && typeof e.new_string === 'string') changed += '\n' + e.new_string;
  }
  // Tambien miramos el propio path (p. ej. tariffs.schema.ts) por si el cuerpo no delata.
  const haystack = changed + '\n' + filePath;

  const matched = moneyPatterns.filter((re) => re.test(haystack)).map((re) => re.source);
  if (!matched.length) return passThrough();

  const context = [
    `El archivo \`${filePath}\` toca un campo de monto (patron: ${matched.slice(0, 5).join(', ')}).`,
    `Antes de continuar, ejecuta el subagente **money-rules-reviewer** sobre este cambio`,
    `para verificar las reglas de \`.claude/money-rules.config.json\` (moneda + tasa al guardar,`,
    `rango, float, redondeo). Si el reviewer reporta violaciones BLOQUEANTES, corrigelas antes de dar el cambio por terminado.`,
  ].join(' ');

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: context,
      },
    }),
  );
  process.exit(0);
}

main();
