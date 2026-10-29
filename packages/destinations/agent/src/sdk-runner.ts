import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkMcpServer, query as sdkQuery, tool } from '@anthropic-ai/claude-agent-sdk'
import { buildSdkOptions, MCP_SERVER_NAME } from './options'
import { AgentRunError, EMPTY_USAGE, type AgentRunInput, type AgentRunResult, type AgentRunner, type AgentUsage } from './types'

export interface SdkRunnerDeps {
  /** Read at run time so a missing key fails the run, not the worker. */
  getApiKey?: () => string | undefined
  query?: typeof sdkQuery
}

const TERMINAL_ERRORS: Record<string, { code: string; retryable: boolean }> = {
  error_max_turns: { code: 'max_turns', retryable: false },
  error_max_budget_usd: { code: 'max_budget', retryable: false },
  error_during_execution: { code: 'execution_error', retryable: true },
  error_max_structured_output_retries: { code: 'output_error', retryable: false },
}

function sumUsage(modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }> | undefined): AgentUsage {
  const total = { ...EMPTY_USAGE }
  for (const u of Object.values(modelUsage ?? {})) {
    total.inputTokens += u.inputTokens
    total.outputTokens += u.outputTokens
    total.cacheReadTokens += u.cacheReadInputTokens
    total.cacheCreationTokens += u.cacheCreationInputTokens
  }
  return total
}

export function createSdkRunner(deps: SdkRunnerDeps = {}): AgentRunner {
  const getApiKey = deps.getApiKey ?? (() => process.env.ANTHROPIC_API_KEY)
  const doQuery = deps.query ?? sdkQuery

  return {
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const apiKey = getApiKey()
      if (!apiKey) throw new AgentRunError('missing_api_key', false)

      const cwd = await mkdtemp(join(tmpdir(), 'relay-agent-'))
      const abortController = new AbortController()
      const onAbort = () => abortController.abort()
      if (input.signal.aborted) onAbort()
      else input.signal.addEventListener('abort', onAbort, { once: true })

      const mcpServer = createSdkMcpServer({
        name: MCP_SERVER_NAME,
        version: '1.0.0',
        alwaysLoad: true,
        tools: input.tools.map((t) =>
          tool(
            t.name,
            t.description,
            t.shape,
            async (args) => {
              const r = await t.call(args as Record<string, unknown>)
              return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) }
            },
            { annotations: { readOnlyHint: !t.mutating, openWorldHint: false } },
          ),
        ),
      })
      const options = buildSdkOptions({
        model: input.model,
        systemPrompt: input.systemPrompt,
        maxTurns: input.maxTurns,
        toolNames: input.tools.map((t) => t.name),
        mcpServer,
        cwd,
        apiKey,
        abortController,
        ...(process.env.PATH ? { pathEnv: process.env.PATH } : {}),
        ...(input.onToolDenied ? { onToolDenied: input.onToolDenied } : {}),
      })

      const q = doQuery({ prompt: input.prompt, options })
      try {
        for await (const message of q) {
          if (message.type !== 'result') continue
          const base = {
            turns: message.num_turns,
            usage: sumUsage(message.modelUsage),
            costUsd: message.total_cost_usd,
          }
          if (message.subtype === 'success' && !message.is_error) return { ...base, finalText: message.result }
          const mapped = message.subtype === 'success' ? { code: 'api_error', retryable: true } : (TERMINAL_ERRORS[message.subtype] ?? { code: 'execution_error', retryable: true })
          return { ...base, finalText: message.subtype === 'success' ? message.result : null, error: mapped }
        }
        throw new AgentRunError('no_result', true)
      } finally {
        input.signal.removeEventListener('abort', onAbort)
        q.close()
        await rm(cwd, { recursive: true, force: true })
      }
    },
  }
}
