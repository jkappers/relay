import { randomBytes } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Cipher } from './crypto'
import type { Db } from './db/client'
import { connections, credentials, type ConnectionRow, type CredentialKind } from './db/schema'
import type { Connection } from './provider'

const toConnection = (row: ConnectionRow): Connection => ({ ...row })

export type Credentials = Partial<Record<CredentialKind, string>>

export interface ConnectionStore {
  findById(id: string): Promise<Connection | null>
  findSlack(teamId: string, userId: string): Promise<Connection | null>
  upsertSlack(input: { teamId: string; userId: string; accessToken: string }): Promise<Connection>
  revokeSlack(teamId: string, userIds: readonly string[]): Promise<number>
  createWebhook(): Promise<{ connection: Connection; secret: string }>
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

    async upsertSlack({ teamId, userId, accessToken }) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(connections)
          .values({ provider: 'slack', teamId, userId, status: 'active' })
          .onConflictDoUpdate({
            target: [connections.provider, connections.teamId, connections.userId],
            set: { status: 'active', updatedAt: sql`now()` },
          })
          .returning()
        if (!row) throw new Error('upsert returned no row')
        await putCredential(tx, row.id, 'slack_user_token', accessToken)
        return toConnection(row)
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

    async createWebhook() {
      const secret = randomBytes(32).toString('hex')
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(connections).values({ provider: 'webhook' }).returning()
        if (!row) throw new Error('insert returned no row')
        await putCredential(tx, row.id, 'webhook_secret', secret)
        return { connection: toConnection(row), secret }
      })
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
