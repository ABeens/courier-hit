/**
 * Acceso a datos del modulo auth (Drizzle). Solo toca SUS tablas.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { clients, emailVerifications, sessions, users } from './auth.schema';

export const authRepo = {
  // --- users ---
  async findUserByEmail(email: string) {
    const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return row ?? null;
  },

  async findUserById(id: string) {
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ?? null;
  },

  async insertUser(values: typeof users.$inferInsert) {
    const [row] = await db.insert(users).values(values).returning();
    if (!row) throw new Error('No se pudo crear el usuario.');
    return row;
  },

  async markEmailVerified(userId: string) {
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId));
  },

  // --- clients (perfil de casillero) ---
  async getClientByUserId(userId: string) {
    const [row] = await db.select().from(clients).where(eq(clients.userId, userId)).limit(1);
    return row ?? null;
  },

  async insertClient(values: typeof clients.$inferInsert) {
    const [row] = await db.insert(clients).values(values).returning();
    if (!row) throw new Error('No se pudo crear el perfil de casillero.');
    return row;
  },

  /** Siguiente codigo de casillero desde la secuencia (HS-####). */
  async nextClientCode(): Promise<string> {
    const rows = (await db.execute(
      sql`select nextval('hs_client_code_seq') as val`,
    )) as Array<{ val: string }>;
    const val = rows[0]?.val;
    if (!val) throw new Error('No se pudo generar el código de casillero.');
    return `HS-${val}`;
  },

  // --- email_verifications ---
  async insertVerification(values: typeof emailVerifications.$inferInsert) {
    const [row] = await db.insert(emailVerifications).values(values).returning();
    if (!row) throw new Error('No se pudo crear el código de verificación.');
    return row;
  },

  async latestVerification(userId: string) {
    const [row] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, userId))
      .orderBy(desc(emailVerifications.createdAt))
      .limit(1);
    return row ?? null;
  },

  async bumpVerificationAttempts(id: string) {
    await db
      .update(emailVerifications)
      .set({ attempts: sql`${emailVerifications.attempts} + 1` })
      .where(eq(emailVerifications.id, id));
  },

  async deleteVerifications(userId: string) {
    await db.delete(emailVerifications).where(eq(emailVerifications.userId, userId));
  },

  // --- sessions ---
  async insertSession(values: typeof sessions.$inferInsert) {
    await db.insert(sessions).values(values);
  },

  async findSession(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row ?? null;
  },

  async deleteSession(id: string) {
    await db.delete(sessions).where(eq(sessions.id, id));
  },
};
