import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url))

interface Journal {
  entries: { tag: string }[]
}

// Copies the folder with the journal cut after `tag`, so drizzle applies migrations up to and including it.
function folderUpTo(tag: string): { dir: string; cleanup: () => void } {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as Journal
  const end = journal.entries.findIndex((e) => e.tag === tag)
  if (end === -1) throw new Error(`unknown migration tag: ${tag}`)
  const dir = mkdtempSync(join(tmpdir(), 'relay-migrations-'))
  cpSync(MIGRATIONS_DIR, dir, { recursive: true })
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, end + 1) }))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export async function runMigrations(url: string, options: { to?: string } = {}): Promise<void> {
  const target = options.to ? folderUpTo(options.to) : null
  const client = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle({ client }), { migrationsFolder: target?.dir ?? MIGRATIONS_DIR })
  } finally {
    await client.end({ timeout: 5 })
    target?.cleanup()
  }
}
