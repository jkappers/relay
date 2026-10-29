import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Db = PostgresJsDatabase<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface DbHandle {
  db: Db
  close(): Promise<void>
}

export function createDb(url: string, options: { max?: number } = {}): DbHandle {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} })
  const db = drizzle({ client, schema })
  return { db, close: () => client.end({ timeout: 5 }) }
}
