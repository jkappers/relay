import { z } from 'zod'

export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5-5'
export const DEFAULT_AGENT_MAX_TURNS = 8
export const DEFAULT_AGENT_TIMEOUT_SECONDS = 300
export const DEFAULT_AGENT_MAX_MUTATING_ACTIONS = 3
export const MAX_AGENT_ATTEMPTS = 3
export const AGENT_LEASE_GRACE_SECONDS = 60

export const agentConfigSchema = z.object({
  systemPrompt: z.string().min(1).max(20_000),
  model: z.string().min(1).max(100).default(DEFAULT_AGENT_MODEL),
  maxTurns: z.number().int().min(1).max(50).default(DEFAULT_AGENT_MAX_TURNS),
  timeoutSeconds: z.number().int().min(5).max(3600).default(DEFAULT_AGENT_TIMEOUT_SECONDS),
  maxMutatingActions: z.number().int().min(0).max(50).default(DEFAULT_AGENT_MAX_MUTATING_ACTIONS),
})
export type AgentConfig = z.output<typeof agentConfigSchema>
export type AgentConfigInput = z.input<typeof agentConfigSchema>
