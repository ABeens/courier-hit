/**
 * CORREOS DIARIOS al cliente (decision P16 del SOW de proformas, con la redaccion
 * que pidio HS Global en "Cambios en los Correos").
 *
 * No hay avisos inmediatos por cambio de estado. Una vez al dia, a la hora
 * configurada (6:00 a. m. por defecto, hora de Costa Rica), salen DOS correos
 * posibles por cliente, cada uno solo si aplica:
 *
 *   1. "Reporte de estatus trámites HS GLOBAL": sus tramites de Transporte y
 *      Agenciamiento en curso (los estados con `Trigger.DailyActiveSummary`).
 *   2. "Reporte de estatus paquetes HS GLOBAL": sale solo si el cliente tiene
 *      algun paquete en Recibido en Miami, En Aduanas o En ruta de entrega
 *      (`Trigger.DailyPackageReport`), y lista TODOS sus paquetes en proceso con
 *      el estado de cada uno. Asi, un paquete que ayer paso a uno de esos estados
 *      aparece en el correo de hoy.
 *
 * Cada correo va en texto plano y en HTML: el HTML pinta el listado en el azul
 * del menu del portal y lleva el enlace "Acceder a Mi Cuenta HS Global".
 *
 * Los correos de cuenta (invitacion, recuperar contraseña) y el comprobante de un
 * pago NO pasan por aqui: siguen siendo inmediatos.
 *
 * Lo programa el robot (`core/scheduler/jobs.ts`, tarea `daily-digest`), que
 * pregunta cada pocos minutos si ya toca (`isDailyDigestDue`).
 */
import {
  DEFAULT_DAILY_DIGEST_HOUR,
  STATE_LABELS,
  Trigger,
  flowForType,
  isDailyDigestDue,
  triggersOnEnter,
} from '@courier/shared';
import type { State } from '@courier/shared';
import { config } from '../../core/config';
import { mailer } from '../../core/mailer';
import { settingsRepo } from '../settings/settings.repo';
import { notificationsRepo } from './notifications.repo';

export const TRAMITES_SUBJECT = 'Reporte de estatus trámites HS GLOBAL';
export const PACKAGES_SUBJECT = 'Reporte de estatus paquetes HS GLOBAL';

/**
 * Azul del menu lateral del portal (`--brand-700` de
 * apps/web/src/styles/tokens.css, oklch(0.43 0.18 263)). En hex porque los
 * clientes de correo no entienden oklch ni variables CSS.
 */
const MENU_BLUE = '#1444b0';
const MUTED = '#5b6270';

/** Una fila del listado: lo que va en azul y el estado actual. */
interface Item {
  label: string;
  state: State;
}

/** Un correo por armar. */
interface Report {
  name: string;
  email: string;
  items: Item[];
}

const portalUrl = (): string => `${config.WEB_ORIGIN}/app`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * El mismo correo en texto y en HTML. `intro` es la frase que cambia entre el de
 * tramites ("envíos") y el de paquetes ("paquetes"); el resto es la redaccion
 * pedida, igual en los dos.
 */
function render(report: Report, intro: string): { body: string; html: string } {
  const url = portalUrl();
  const text = [
    `Hola ${report.name},`,
    '',
    intro,
    '',
    ...report.items.map((i) => `${i.label} (${STATE_LABELS[i.state]})`),
    '',
    'Recuerde que puede consultar en tiempo real el detalle completo de cada envío, incluyendo seguimiento, fotos y actualizaciones, ingresando a nuestra plataforma:',
    '',
    `Acceder a Mi Cuenta HS Global: ${url}`,
    '',
    'Si tiene alguna consulta, no dude en contactar a su ejecutivo de cuenta.',
    '',
    'Saludos,',
    '',
    'Equipo HS Global',
  ].join('\n');

  const p = (content: string) => `<p style="margin:0 0 16px">${content}</p>`;
  const rows = report.items
    .map(
      (i) =>
        `<li style="margin:0 0 6px"><span style="color:${MENU_BLUE};font-weight:600">${escapeHtml(i.label)}</span>` +
        ` <span style="color:${MUTED}">(${escapeHtml(STATE_LABELS[i.state])})</span></li>`,
    )
    .join('');
  const html = [
    '<!doctype html><html lang="es"><body style="margin:0;padding:24px;background:#ffffff">',
    '<div style="max-width:600px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2430">',
    p(`Hola ${escapeHtml(report.name)},`),
    p(escapeHtml(intro)),
    `<ul style="margin:0 0 16px;padding-left:20px">${rows}</ul>`,
    p('Recuerde que puede consultar en tiempo real el detalle completo de cada envío, incluyendo seguimiento, fotos y actualizaciones, ingresando a nuestra plataforma:'),
    p(
      `<a href="${escapeHtml(url)}" style="display:inline-block;background:${MENU_BLUE};color:#ffffff;` +
        'text-decoration:none;font-weight:600;padding:10px 18px;border-radius:6px">Acceder a Mi Cuenta HS Global</a>',
    ),
    p('Si tiene alguna consulta, no dude en contactar a su ejecutivo de cuenta.'),
    p('Saludos,<br>Equipo HS Global'),
    '</div></body></html>',
  ].join('');

  return { body: text, html };
}

/** Agrupa filas por cliente conservando el orden de la consulta. */
function byClient<T extends { clientId: string; name: string; email: string }>(
  rows: readonly T[],
): Map<string, { name: string; email: string; rows: T[] }> {
  const map = new Map<string, { name: string; email: string; rows: T[] }>();
  for (const row of rows) {
    const found = map.get(row.clientId);
    if (found) found.rows.push(row);
    else map.set(row.clientId, { name: row.name, email: row.email, rows: [row] });
  }
  return map;
}

const has = (trigger: Trigger) => (row: { shipmentType: Parameters<typeof flowForType>[0]; state: State }) =>
  triggersOnEnter(flowForType(row.shipmentType), row.state).includes(trigger);

export const notificationsService = {
  /**
   * Arma y envia los correos diarios de todos los clientes a los que les toca.
   * Devuelve cuantos correos salieron (uno por cliente y por tipo de correo).
   */
  async sendDailyDigest(): Promise<{ sent: number }> {
    const [tramites, packages] = await Promise.all([
      notificationsRepo.tramites(),
      notificationsRepo.packagesInProcess(),
    ]);
    let sent = 0;

    // --- 1. Tramites: solo los que estan en curso ---
    const inCourse = has(Trigger.DailyActiveSummary);
    for (const client of byClient(tramites.filter(inCourse)).values()) {
      const report: Report = {
        name: client.name,
        email: client.email,
        items: client.rows.map((r) => ({ label: `Trámite: ${r.code} - ${r.description}`, state: r.state })),
      };
      const { body, html } = render(report, 'Le compartimos el estado actualizado de todos sus envíos:');
      await mailer.send({ to: client.email, subject: TRAMITES_SUBJECT, body, html });
      sent++;
    }

    // --- 2. Paquetes: todos los en proceso, si alguno esta en un estado que avisa ---
    const notifies = has(Trigger.DailyPackageReport);
    for (const client of byClient(packages).values()) {
      if (!client.rows.some(notifies)) continue;
      const report: Report = {
        name: client.name,
        email: client.email,
        items: client.rows.map((r) => ({
          label: `${r.code} - ${r.hawb ?? r.tracking} - ${r.description}`,
          state: r.state,
        })),
      };
      const { body, html } = render(report, 'Le compartimos el estado actualizado de todos sus paquetes:');
      await mailer.send({ to: client.email, subject: PACKAGES_SUBJECT, body, html });
      sent++;
    }

    console.log(`[digest] correos diarios enviados: ${sent}`);
    return { sent };
  },

  /**
   * Lo que corre el robot: si ya toca (hora configurada alcanzada y no enviado
   * hoy), envia los correos diarios y deja constancia del envio. Devuelve null si
   * todavia no tocaba.
   */
  async runIfDue(now: Date = new Date()): Promise<{ sent: number } | null> {
    const setting = await settingsRepo.dailyDigest();
    const hour = setting.hour ?? DEFAULT_DAILY_DIGEST_HOUR;
    if (!isDailyDigestDue(now, hour, setting.lastRunAt)) return null;
    return this.runNow(now);
  },

  /**
   * Envia los correos diarios YA. Lo usan el robot y el boton de "enviar ahora"
   * del administrador. La constancia se deja DESPUES de enviar: si el envio se
   * cae a medias, el siguiente intento vuelve a salir en vez de darse por hecho.
   */
  async runNow(now: Date = new Date()): Promise<{ sent: number }> {
    const result = await this.sendDailyDigest();
    await settingsRepo.markDailyDigestRun(now);
    return result;
  },
};
