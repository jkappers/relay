import { existsSync } from 'node:fs'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSdkRunner } from '../src/sdk-runner'
import { AgentRunError, type AgentRunInput, type AgentToolDef } from '../src/types'

const tools: AgentToolDef[] = [
  { name: 'reply', action: 'reply', description: 'd', shape: { text: z.string() }, mutating: true, call: async () => ({ isError: false, text: 'ok' }) },
]
const input = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  model: 'claude-sonnet-5-5',
  systemPrompt: 's',
  prompt: 'p',
  maxTurns: 4,
  tools,
  signal: new AbortController().signal,
  ...over,
})

function fakeQuery(messages: unknown[], seen: { options?: Record<string, unknown>; cwdExisted?: boolean; closed?: boolean }) {
  return ((params: { prompt: string; options: Record<string, unknown> }) => {
    seen.options = params.options
    seen.cwdExisted = existsSync(params.options.cwd as string)
    const gen = (async function* () {
      for (const m of messages) yield m
    })() as unknown as ReturnType<typeof query>
    ;(gen as unknown as { close: () => void }).close = () => void (seen.closed = true)
    return gen
  }) as unknown as typeof query
}

const modelUsage = { 'claude-sonnet-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 3, costUSD: 0.01 } }
const success = { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2, total_cost_usd: 0.01, modelUsage }

describe('createSdkRunner', () => {
  it('fails clearly without an API key, before touching the SDK', async () => {
    const runner = createSdkRunner({ getApiKey: () => undefined, query: (() => { throw new Error('should not run') }) as never })
    await expect(runner.run(input())).rejects.toMatchObject({ name: 'AgentRunError', code: 'missing_api_key', retryable: false })
  })

  it('maps a success result, runs in a temp cwd, and removes it', async () => {
    const seen: { options?: Record<string, unknown>; cwdExisted?: boolean; closed?: boolean } = {}
    const runner = createSdkRunner({ getApiKey: () => 'k', query: fakeQuery([{ type: 'system' }, success], seen) })
    const res = await runner.run(input())
    expect(res).toEqual({
      finalText: 'done',
      turns: 2,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 3 },
      costUsd: 0.01,
    })
    const cwd = seen.options!.cwd as string
    expect(seen.cwdExisted).toBe(true)
    expect(existsSync(cwd)).toBe(false)
    expect(seen.closed).toBe(true)
    expect(seen.options!.tools).toEqual([])
    expect(seen.options!.maxTurns).toBe(4)
    expect(seen.options!.allowedTools).toEqual(['mcp__relay__reply'])
  })

  it('maps error subtypes, keeping usage', async () => {
    const msg = { ...success, subtype: 'error_max_turns', errors: [] }
    const runner = createSdkRunner({ getApiKey: () => 'k', query: fakeQuery([msg], {}) })
    expect(await runner.run(input())).toMatchObject({ finalText: null, error: { code: 'max_turns', retryable: false }, usage: { inputTokens: 100 } })
  })

  it('throws a retryable error when the stream ends without a result, and still cleans up', async () => {
    const seen: { options?: Record<string, unknown> } = {}
    const runner = createSdkRunner({ getApiKey: () => 'k', query: fakeQuery([], seen) })
    await expect(runner.run(input())).rejects.toBeInstanceOf(AgentRunError)
    expect(existsSync(seen.options!.cwd as string)).toBe(false)
  })

  it('aborts the SDK controller when the run signal aborts', async () => {
    const seen: { options?: Record<string, unknown> } = {}
    const ac = new AbortController()
    const runner = createSdkRunner({ getApiKey: () => 'k', query: fakeQuery([success], seen) })
    ac.abort()
    await runner.run(input({ signal: ac.signal }))
    expect((seen.options!.abortController as AbortController).signal.aborted).toBe(true)
  })
})
