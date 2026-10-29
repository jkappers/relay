import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { schema, type Db } from '@relay/core'
import { PASSWORD_MAX, PASSWORD_MIN, type PasswordHasher } from './password'

const { users, sessions } = schema

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((e) => e.toLowerCase())
export const passwordSchema = z.string().min(PASSWORD_MIN, `must be at least ${PASSWORD_MIN} characters`).max(PASSWORD_MAX)
export const credentialsInput = z.object({ email: emailSchema, password: passwordSchema })

export class EmailTakenError extends Error {
  override name = 'EmailTakenError'
}

export async function findUserByEmail(db: Db, email: string): Promise<schema.UserRow | null> {
  const [row] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase()))
  return row ?? null
}

/** `admin` is for the CLI only. The HTTP sign-up path never passes it. */
export async function createUser(
  db: Db,
  hasher: PasswordHasher,
  input: { email: string; password: string },
  opts: { admin?: boolean } = {},
): Promise<schema.UserRow> {
  const { email, password } = credentialsInput.parse(input)
  const passwordHash = await hasher.hash(password)
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash, isAdmin: opts.admin === true })
    .onConflictDoNothing()
    .returning()
  if (!row) throw new EmailTakenError('an account with that email already exists')
  return row
}

/** Grants or revokes instance admin. Takes effect on the user's next request. */
export async function setAdmin(db: Db, email: string, admin: boolean): Promise<schema.UserRow> {
  const [row] = await db
    .update(users)
    .set({ isAdmin: admin, updatedAt: new Date() })
    .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
    .returning()
  if (!row) throw new Error(`no user with email ${email}`)
  return row
}

export async function isAdmin(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId))
  return row?.isAdmin === true
}

/** Sets a new password and ends every session the user has. Returns the number of sessions ended. */
export async function setPassword(db: Db, hasher: PasswordHasher, input: { email: string; password: string }): Promise<number> {
  const { email, password } = credentialsInput.parse(input)
  const passwordHash = await hasher.hash(password)
  return db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(sql`lower(${users.email})`, email))
      .returning({ id: users.id })
    if (!user) throw new Error(`no user with email ${email}`)
    const ended = await tx.delete(sessions).where(eq(sessions.userId, user.id)).returning({ id: sessions.id })
    return ended.length
  })
}
