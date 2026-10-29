import type { AgentRunInput, AgentRunResult, AgentRunner } from './types'
import { EMPTY_USAGE } from './types'

export type FakeRunnerScript = (input: AgentRunInput) => Promise<Partial<AgentRunResult> | void>

/** A runner with no network. Tests script it; `RELAY_AGENT_RUNNER=fake` uses the demo script. */
export function createFakeRunner(script: FakeRunnerScript): AgentRunner {
  return {
    async run(input) {
      const out = (await script(input)) ?? {}
      return { finalText: 'done', turns: 1, usage: { ...EMPTY_USAGE, inputTokens: 10, outputTokens: 5 }, costUsd: 0.001, ...out }
    },
  }
}

export function createDemoRunner(): AgentRunner {
  return createFakeRunner(async (input) => {
    const byName = (n: string) => input.tools.find((t) => t.name === n)
    await byName('thread_history')?.call({})
    const used: string[] = []
    for (const t of input.tools) {
      if (t.kind !== 'tool') continue
      const r = await t.call(t.example ?? {})
      used.push(`${t.name}:${r.isError ? 'error' : 'ok'}`)
    }
    await byName('reply')?.call({ text: used.length ? `Fake agent reply. Tools: ${used.join(', ')}.` : 'Fake agent reply.' })
    return { finalText: 'Replied with the fake agent.' }
  })
}
