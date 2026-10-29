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
    await byName('reply')?.call({ text: 'Fake agent reply.' })
    return { finalText: 'Replied with the fake agent.' }
  })
}
