/**
 * Seed del primer administrador (bootstrap del sistema). El unico admin inicial
 * no puede autoregistrarse (solo clientes lo hacen) ni recibir invitacion (aun no
 * hay correo), asi que se siembra aqui.
 *
 * Idempotente: si el correo ya existe, no toca nada... salvo que pases --force
 * (o SEED_ADMIN_FORCE=1), que restablece su contrasena y lo reactiva. La clave
 * sale de SEED_ADMIN_PASSWORD; si no se define, se genera una ROBUSTA y se
 * imprime una sola vez. El admin nace verificado y activo (docs/roles.md §1.2).
 *
 * Uso: pnpm --filter @courier/api db:seed
 *      pnpm --filter @courier/api db:seed -- --force   (resetea la clave)
 *   Variables opcionales: SEED_ADMIN_EMAIL, SEED_ADMIN_NAME, SEED_ADMIN_PASSWORD
 */
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { count, eq } from 'drizzle-orm';
import { Currency, Principal, Role, UserStatus } from '@courier/shared';
import { db } from './core/db';
import { users } from './modules/auth/auth.schema';
import { clientRates } from './modules/tariffs/tariffs.schema';

/**
 * Tarifas preferenciales de cliente de ejemplo (requisito). Basica es la tarifa
 * por defecto a la que se incorporan los casilleros nuevos. Se siembran solo si
 * la tabla esta vacia (idempotente): no pisa ediciones posteriores del admin.
 */
const SEED_CLIENT_RATES: { name: string; pricePerKg: number; isDefault?: boolean }[] = [
  { name: 'Básica', pricePerKg: 13.45, isDefault: true },
  { name: 'Plus', pricePerKg: 9.75 },
  { name: 'Pro', pricePerKg: 8.45 },
  { name: 'Gold', pricePerKg: 8.15 },
  { name: 'Black', pricePerKg: 7.45 },
  { name: 'Platinum', pricePerKg: 7.2 },
];

async function seedClientRates(): Promise<void> {
  const [row] = await db.select({ n: count() }).from(clientRates);
  if ((row?.n ?? 0) > 0) {
    console.log('[seed] Tarifas de cliente: ya existen, no se cambió nada.');
    return;
  }
  await db.insert(clientRates).values(
    SEED_CLIENT_RATES.map((r) => ({
      name: r.name,
      pricePerKg: r.pricePerKg,
      // Precios de importacion desde Miami: se cotizan en dolares (regla M2).
      currency: Currency.USD,
      isDefault: r.isDefault ?? false,
      allowsCard: true,
      allowsBankDeposit: true,
    })),
  );
  console.log(`[seed] Tarifas de cliente creadas: ${SEED_CLIENT_RATES.length} (Básica por defecto).`);
}

/** Contrasena de alta entropia con las 4 clases de caracteres garantizadas. */
function strongPassword(): string {
  const body = randomBytes(24).toString('base64url'); // ~32 chars, cripto-aleatorio
  return `Hg${body}#7`; // asegura mayuscula, minuscula, digito y simbolo
}

function printCreds(email: string, id: string | undefined, password: string, provided: boolean, action: string): void {
  console.log(`\n[seed] Administrador ${action}:`);
  console.log(`  id:     ${id}`);
  console.log(`  correo: ${email}`);
  console.log('  rol:    admin (verificado, activo)');
  if (provided) {
    console.log('  clave:  (la definida en SEED_ADMIN_PASSWORD)');
  } else {
    console.log(`  clave:  ${password}`);
    console.log('  ^^ Guárdala ahora: no se vuelve a mostrar.');
  }
  console.log('');
}

async function main(): Promise<void> {
  await seedClientRates();

  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@hsglobal.ltd').trim().toLowerCase();
  const name = process.env.SEED_ADMIN_NAME ?? 'Administrador HS';
  const provided = process.env.SEED_ADMIN_PASSWORD;
  const force = process.argv.includes('--force') || process.env.SEED_ADMIN_FORCE === '1';
  const password = provided && provided.length >= 6 ? provided : strongPassword();

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    if (!force) {
      console.log(`[seed] El usuario ${email} ya existe (id ${existing.id}). No se cambió nada.`);
      console.log('  Para restablecer su contraseña: agrega -- --force (o SEED_ADMIN_FORCE=1).');
      return;
    }
    const passwordHash = await hash(password);
    await db
      .update(users)
      .set({ passwordHash, status: UserStatus.Activo, emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, existing.id));
    printCreds(email, existing.id, password, Boolean(provided), 'restablecido (--force)');
    return;
  }

  const passwordHash = await hash(password);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      principal: Principal.Staff,
      role: Role.Admin,
      name,
      status: UserStatus.Activo,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });

  printCreds(email, row?.id, password, Boolean(provided), 'creado');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] error:', err);
    process.exit(1);
  });
