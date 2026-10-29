import type { z } from 'zod'

export interface AgentToolResult {
  isError: boolean
  text: string
}

export interface AgentToolDef {
  name: string
  action: string
  description: string
  shape: z.ZodRawShape
  mutating: boolean
  call(args: Record<string, unknown>): Promise<AgentToolResult>
}

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export const EMPTY_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }

export interface AgentRunInput {
  model: string
  systemPrompt: string
  prompt: string
  maxTurns: number
  tools: AgentToolDef[]
  signal: AbortSignal
  onToolDenied?: (toolName: string) => void
}

export interface AgentRunResult {
  finalText: string | null
  turns: number
  usage: AgentUsage
  costUsd: number
  error?: { code: string; retryable: boolean }
}

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>
}

export class AgentRunError extends Error {
  override name = 'AgentRunError'
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code)
  }
}
