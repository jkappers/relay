import { describe, expect, it } from 'vitest'
import { workerEnvSchema } from '../src/config'

const base = {
  DATABASE_URL: 'postgres://x',
  RELAY_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_URL: 'https://relay.example.com',
}

describe('worker config', () => {
  it('defaults to the real runner with concurrency 1', () => {
    expect(workerEnvSchema.parse(base)).toMatchObject({ RELAY_AGENT_RUNNER: 'sdk', AGENT_CONCURRENCY: 1 })
  })

  it('allows the fake runner outside production', () => {
    expect(workerEnvSchema.safeParse({ ...base, RELAY_AGENT_RUNNER: 'fake' }).success).toBe(true)
    expect(workerEnvSchema.safeParse({ ...base, RELAY_AGENT_RUNNER: 'fake', NODE_ENV: 'development' }).success).toBe(true)
  })

  it('refuses the fake runner when NODE_ENV=production', () => {
    expect(workerEnvSchema.safeParse({ ...base, RELAY_AGENT_RUNNER: 'fake', NODE_ENV: 'production' }).success).toBe(false)
    expect(workerEnvSchema.safeParse({ ...base, NODE_ENV: 'production' }).success).toBe(true)
  })

  it('makes the Discord bot token optional', () => {
    const parsed = workerEnvSchema.parse(base)
    expect(parsed.DISCORD_BOT_TOKEN).toBeUndefined()
    expect(parsed.DISCORD_API_BASE_URL).toBe('https://discord.com/api/v10')
    expect(workerEnvSchema.parse({ ...base, DISCORD_BOT_TOKEN: ' t ' }).DISCORD_BOT_TOKEN).toBe('t')
  })
})
