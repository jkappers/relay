import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentConfigSchema, createAgentDestination, createDb, schema, type Db } from '../src'
import { resetDb, TEST_DATABASE_URL } from '../src/testing'

let db: Db
let close: () => Promise<void>
beforeAll(async () => {
  const h = createDb(TEST_DATABASE_URL, { max: 2 })
  db = h.db
  close = h.close
  await resetDb(db)
})
afterAll(async () => {
  await resetDb(db)
  await close()
})

describe('agent config', () => {
  it('applies defaults', () => {
    expect(agentConfigSchema.parse({ systemPrompt: 'x' })).toEqual({
      systemPrompt: 'x',
      model: 'claude-sonnet-5-5',
      maxTurns: 8,
      timeoutSeconds: 300,
      maxMutatingActions: 3,
    })
  })

  it('rejects bad values', () => {
    expect(agentConfigSchema.safeParse({}).success).toBe(false)
    expect(agentConfigSchema.safeParse({ systemPrompt: '' }).success).toBe(false)
    expect(agentConfigSchema.safeParse({ systemPrompt: 'x', maxTurns: 0 }).success).toBe(false)
    expect(agentConfigSchema.safeParse({ systemPrompt: 'x', timeoutSeconds: 1 }).success).toBe(false)
    expect(agentConfigSchema.safeParse({ systemPrompt: 'x', maxMutatingActions: -1 }).success).toBe(false)
  })

  const connection = async () => (await db.insert(schema.connections).values({ provider: 'webhook' }).returning())[0]!.id

  it('stores an agent destination without a url or secret', async () => {
    const d = await createAgentDestination(db, await connection(), { name: 'a', config: { systemPrompt: 'x', maxTurns: 2 } })
    expect(d).toMatchObject({ kind: 'agent', url: null, secretCiphertext: null, config: { systemPrompt: 'x', maxTurns: 2, model: 'claude-sonnet-5-5' } })
  })

  it('the database refuses an http destination without url and secret', async () => {
    const connectionId = await connection()
    await expect(db.insert(schema.destinations).values({ connectionId, name: 'bad', kind: 'http' })).rejects.toThrow()
    await expect(db.insert(schema.destinations).values({ connectionId, name: 'bad', kind: 'http', url: 'http://x.test' })).rejects.toThrow()
  })
})
