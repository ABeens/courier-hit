/**
 * Vista previa de los CORREOS DIARIOS, para revisarlos o mostrarlos en una demo.
 *
 * Uso: pnpm --filter @courier/api db:preview-mail [carpeta-de-salida]
 *
 * Arma los mismos correos que el robot enviaria ahora mismo
 * (`notificationsService.sendDailyDigest`), pero en vez de enviarlos escribe cada
 * uno como un archivo HTML en la carpeta de salida, mas un `index.html` con la
 * lista. No envia nada ni marca el envio del dia: el correo real de las 6 a. m.
 * sale igual.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mailer } from './core/mailer';
import type { MailMessage } from './core/mailer';
import { notificationsService } from './modules/notifications/notifications.service';

const outDir = resolve(process.argv[2] ?? 'correos-diarios');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const outbox: MailMessage[] = [];
// Se intercepta el envio: nada sale del equipo.
mailer.send = async (message: MailMessage) => {
  outbox.push(message);
};

await notificationsService.sendDailyDigest();

const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const links = outbox.map((m, i) => {
  const file = `${String(i + 1).padStart(2, '0')}.html`;
  writeFileSync(join(outDir, file), m.html ?? `<pre>${escape(m.body)}</pre>`, 'utf8');
  return `<li><a href="${file}">${escape(m.subject)}</a> <span style="color:#5b6270">para ${escape(m.to)}</span></li>`;
});

writeFileSync(
  join(outDir, 'index.html'),
  '<!doctype html><html lang="es"><meta charset="utf-8"><title>Correos diarios</title>' +
    '<body style="font-family:Arial,Helvetica,sans-serif;padding:24px">' +
    `<h1 style="font-size:20px">Correos diarios (${outbox.length})</h1>` +
    (outbox.length ? `<ol>${links.join('')}</ol>` : '<p>Hoy no le toca correo a ningún cliente.</p>') +
    '</body></html>',
  'utf8',
);

console.log(`${outbox.length} correos escritos en ${outDir}`);
console.log(`Abrir: ${join(outDir, 'index.html')}`);
process.exit(0);
