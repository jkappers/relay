import { sql } from 'drizzle-orm'
import type { Db } from './db/client'

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://relay:relay@localhost:54329/relay_test'

export const TEST_MASTER_KEY = new Uint8Array(32).fill(7)

export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`truncate table events, credentials, connections cascade`)
  await db.execute(sql`do $$ begin if to_regclass('pgboss.job') is not null then delete from pgboss.job; end if; end $$`)
}
