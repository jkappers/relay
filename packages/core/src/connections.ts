import { randomBytes } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Cipher } from './crypto'
import type { Db } from './db/client'
import { connectionMembers, connections, credentials, type ConnectionRow, type CredentialKind } from './db/schema'
import type { Connection } from './provider'

const toConnection = (row: ConnectionRow): Connection => ({ ...row })

export type Credentials = Partial<Record<CredentialKind, string>>

/** The Slack identity already belongs to another Relay account. Nothing was stored. */
export class ConnectionOwnedError extends Error {
  override name = 'ConnectionOwnedError'
}

export interface ConnectionSummary {
  id: string
  name: string | null
  provider: string
  teamId: string | null
  userId: string | null
  status: Connection['status']
  role: 'owner'
  createdAt: Date
}

export interface ConnectionStore {
  findById(id: string): Promise<Connection | null>
  findSlack(teamId: string, userId: string): Promise<Connection | null>
  /** `ownerUserId` null only for seeding without accounts. Otherwise throws ConnectionOwnedError if someone else owns it. */
  upsertSlack(input: { teamId: string; userId: string; accessToken: string; ownerUserId: string | null }): Promise<Connection>
  revokeSlack(teamId: string, userIds: readonly string[]): Promise<number>
  createWebhook(input: { name?: string; ownerUserId: string | null }): Promise<{ connection: Connection; secret: string }>
  /** `number` is E.164. Throws ConnectionOwnedError if that account/number pair already exists. */
  createSms(input: { name?: string; accountSid: string; number: string; authToken: string; ownerUserId: string | null }): Promise<Connection>
  listForUser(userId: string): Promise<ConnectionSummary[]>
  getCredentials(connectionId: string): Promise<Credentials>
  getWebhookSecret(connectionId: string): Promise<string | null>
}

export function createConnectionStore(db: Db, cipher: Cipher): ConnectionStore {
  async function putCredential(tx: Pick<Db, 'insert'>, connectionId: string, kind: CredentialKind, plaintext: string) {
    const ciphertext = cipher.encrypt(plaintext)
    await tx
      .insert(credentials)
      .values({ connectionId, kind, ciphertext })
      .onConflictDoUpdate({
        target: [credentials.connectionId, credentials.kind],
        set: { ciphertext, updatedAt: sql`now()` },
      })
  }

  async function getCredentials(connectionId: string): Promise<Credentials> {
    const rows = await db.select().from(credentials).where(eq(credentials.connectionId, connectionId))
    const out: Credentials = {}
    for (const row of rows) out[row.kind] = cipher.decrypt(row.ciphertext)
    return out
  }

  return {
    async findById(id) {
      const [row] = await db.select().from(connections).where(eq(connections.id, id))
      return row ? toConnection(row) : null
    },

    async findSlack(teamId, userId) {
      const [row] = await db
        .select()
        .from(connections)
        .where(and(eq(connections.provider, 'slack'), eq(connections.teamId, teamId), eq(connections.userId, userId)))
      return row ? toConnection(row) : null
    },

    async upsertSlack({ teamId, userId, accessToken, ownerUserId }) {
      return db.transaction(async (tx) => {
        await tx
          .insert(connections)
          .values({ provider: 'slack', teamId, userId, name: `Slack ${teamId}/${userId}`, status: 'active' })
          .onConflictDoNothing({ target: [connections.provider, connections.teamId, connections.userId] })
        const [row] = await tx
          .select()
          .from(connections)
          .where(and(eq(connections.provider, 'slack'), eq(connections.teamId, teamId), eq(connections.userId, userId)))
          .for('update')
        if (!row) throw new Error('upsert found no row')
        if (ownerUserId !== null) {
          const members = await tx
            .select({ userId: connectionMembers.userId })
            .from(connectionMembers)
            .where(eq(connectionMembers.connectionId, row.id))
          if (members.length > 0 && !members.some((m) => m.userId === ownerUserId)) {
            throw new ConnectionOwnedError('this Slack identity is connected to another Relay account')
          }
          if (members.length === 0) await tx.insert(connectionMembers).values({ connectionId: row.id, userId: ownerUserId, role: 'owner' })
        }
        const [active] = await tx
          .update(connections)
          .set({ status: 'active', updatedAt: sql`now()` })
          .where(eq(connections.id, row.id))
          .returning()
        await putCredential(tx, row.id, 'slack_user_token', accessToken)
        return toConnection(active!)
      })
    },

    async revokeSlack(teamId, userIds) {
      if (userIds.length === 0) return 0
      const rows = await db
        .update(connections)
        .set({ status: 'revoked', updatedAt: sql`now()` })
        .where(and(eq(connections.provider, 'slack'), eq(connections.teamId, teamId), inArray(connections.userId, [...userIds])))
        .returning({ id: connections.id })
      return rows.length
    },

    async createWebhook({ name, ownerUserId }) {
      const secret = randomBytes(32).toString('hex')
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(connections)
          .values({ provider: 'webhook', name: name ?? 'Webhook' })
          .returning()
        if (!row) throw new Error('insert returned no row')
        if (ownerUserId !== null) await tx.insert(connectionMembers).values({ connectionId: row.id, userId: ownerUserId, role: 'owner' })
        await putCredential(tx, row.id, 'webhook_secret', secret)
        return { connection: toConnection(row), secret }
      })
    },

    async createSms({ name, accountSid, number, authToken, ownerUserId }) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(connections)
          .values({ provider: 'sms', teamId: accountSid, userId: number, name: name ?? `SMS ${number}` })
          .onConflictDoNothing({ target: [connections.provider, connections.teamId, connections.userId] })
          .returning()
        if (!row) throw new ConnectionOwnedError('this Twilio number is already connected')
        if (ownerUserId !== null) await tx.insert(connectionMembers).values({ connectionId: row.id, userId: ownerUserId, role: 'owner' })
        await putCredential(tx, row.id, 'sms_auth_token', authToken)
        return toConnection(row)
      })
    },

    async listForUser(userId) {
      return db
        .select({
          id: connections.id,
          name: connections.name,
          provider: connections.provider,
          teamId: connections.teamId,
          userId: connections.userId,
          status: connections.status,
          role: connectionMembers.role,
          createdAt: connections.createdAt,
        })
        .from(connectionMembers)
        .innerJoin(connections, eq(connections.id, connectionMembers.connectionId))
        .where(eq(connectionMembers.userId, userId))
        .orderBy(connections.createdAt, connections.id)
    },

    getCredentials,

    async getWebhookSecret(connectionId) {
      const [row] = await db
        .select({ ciphertext: credentials.ciphertext })
        .from(credentials)
        .innerJoin(connections, eq(connections.id, credentials.connectionId))
        .where(and(eq(credentials.connectionId, connectionId), eq(credentials.kind, 'webhook_secret'), eq(connections.provider, 'webhook')))
      return row ? cipher.decrypt(row.ciphertext) : null
    },
  }
}
