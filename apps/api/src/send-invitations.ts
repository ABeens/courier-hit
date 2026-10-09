/**
 * Envio masivo de la invitacion a los clientes que todavia no tienen contrasena
 * (los de la carga inicial, `import-clients.ts`). Es el mismo correo que sale
 * cuando un administrador crea un cliente desde el panel
 * (`authService.issueInvitation`): un enlace para definir la contrasena, que al
 * usarse tambien verifica el correo.
 *
 * A quien se le manda (todo a la vez):
 *  - casillero de cliente, usuario ACTIVO y con el correo SIN verificar (nunca
 *    definio contrasena);
 *  - enlace con Helga `synced`. Con la integracion encendida el login exige
 *    `synced`: invitar a uno pendiente le daria una contrasena con la que aun no
 *    puede entrar. Esos se listan aparte;
 *  - sin una invitacion VIGENTE sin usar, para que repetir el envio tras un corte
 *    no le duplique el correo a quien ya lo recibio. INVITE_RESEND=1 lo ignora.
 *
 * Antes de emitir la nueva se anulan las invitaciones anteriores del cliente:
 * solo sirve el ultimo enlace enviado.
 *
 * Variables:
 *   INVITE_CONFIRM=1     envia. Sin ella solo lista.
 *   INVITE_CODES=HS-1003,HS-1004   limita a esos casilleros (para probar).
 *   INVITE_RESEND=1      incluye a quien ya tiene una invitacion vigente.
 *   INVITE_DELAY_MS=1000 pausa entre correos (el limite de envio de SES).
 */
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { HelgaSyncStatus, Principal, UserStatus } from '@courier/shared';
import { config } from './core/config';
import { db } from './core/db';
import { clients, passwordResets, users } from './modules/auth/auth.schema';
import { authRepo } from './modules/auth/auth.repo';
import { authService } from './modules/auth/auth.service';

const CONFIRMED = process.env.INVITE_CONFIRM === '1';
const RESEND = process.env.INVITE_RESEND === '1';
const DELAY_MS = Number(process.env.INVITE_DELAY_MS ?? 1000);
const CODES = (process.env.INVITE_CODES ?? '')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const candidates = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      code: clients.code,
      syncStatus: clients.helgaSyncStatus,
    })
    .from(users)
    .innerJoin(clients, eq(clients.userId, users.id))
    .where(
      and(
        eq(users.principal, Principal.Client),
        eq(users.status, UserStatus.Activo),
        isNull(users.emailVerifiedAt),
        ...(CODES.length > 0 ? [inArray(clients.code, CODES)] : []),
      ),
    )
    .orderBy(clients.code);

  const pendingInvites = await db
    .select({ userId: passwordResets.userId })
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.purpose, 'invite'),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, new Date()),
      ),
    );
  const invited = new Set(pendingInvites.map((r) => r.userId));

  const notLinked = candidates.filter((c) => c.syncStatus !== HelgaSyncStatus.Synced);
  const alreadyInvited = candidates.filter((c) => c.syncStatus === HelgaSyncStatus.Synced && invited.has(c.userId) && !RESEND);
  const toSend = candidates.filter((c) => c.syncStatus === HelgaSyncStatus.Synced && (RESEND || !invited.has(c.userId)));

  if (CODES.length > 0) {
    const found = new Set(candidates.map((c) => c.code));
    for (const code of CODES.filter((c) => !found.has(c))) {
      console.log(`  [NO APLICA] ${code}: no existe, está deshabilitado o ya tiene contraseña.`);
    }
  }
  for (const c of notLinked) console.log(`  [ESPERA]   ${c.code} ${c.name}: enlace con Helga "${c.syncStatus}", aún no podría entrar.`);
  for (const c of alreadyInvited) console.log(`  [YA TIENE] ${c.code} ${c.name}: invitación vigente sin usar (INVITE_RESEND=1 para reenviar).`);
  for (const c of toSend) console.log(`  [ENVIAR]   ${c.code} ${c.name} <${c.email}>`);

  console.log(
    `\nRESUMEN: ${toSend.length} por enviar, ${alreadyInvited.length} ya invitados, ${notLinked.length} esperando enlace con Helga.`,
  );
  console.log(`Los enlaces vencen a las ${config.INVITE_TTL_HOURS} horas de enviados.`);

  if (!CONFIRMED) {
    console.log('[simulación] no se envió ningún correo.');
    return;
  }

  console.log('\nEnviando...');
  let sent = 0;
  for (const c of toSend) {
    try {
      // Solo el ultimo enlace sirve: los anteriores (vencidos o no) se anulan.
      await authRepo.invalidatePasswordResets(c.userId, 'invite');
      await authService.issueInvitation(c.userId, c.email, 'client');
      sent++;
      console.log(`  enviado  ${c.code} <${c.email}>`);
    } catch (err) {
      console.error(`  FALLÓ   ${c.code} <${c.email}>: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(DELAY_MS);
  }
  // El mailer no lanza si SES rechaza un correo: lo registra como
  // "[mailer] no se pudo enviar". Si aparece arriba, ese cliente no lo recibio.
  console.log(`\nInvitaciones emitidas: ${sent} de ${toSend.length}. Revisa arriba si hay líneas "[mailer] no se pudo enviar".`);
  if (sent < toSend.length) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[enviar-invitaciones] falló:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
