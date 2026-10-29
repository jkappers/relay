import { and, eq } from 'drizzle-orm'
import type { Db } from './db/client'
import { sentMessages } from './db/schema'

export async function hasSentMessage(db: Db, connectionId: string, channel: string, ts: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sentMessages.id })
    .from(sentMessages)
    .where(and(eq(sentMessages.connectionId, connectionId), eq(sentMessages.channel, channel), eq(sentMessages.ts, ts)))
  return Boolean(row)
}
