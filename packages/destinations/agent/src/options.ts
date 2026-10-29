import { BUILTIN_TOOL_NAMES } from '@anthropic-ai/claude-agent-sdk'
import type { CanUseTool, HookCallbackMatcher, McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk'

export const MCP_SERVER_NAME = 'relay'

export const mcpToolName = (toolName: string) => `mcp__${MCP_SERVER_NAME}__${toolName}`

/** Belt and braces: `tools: []` already removes the built-ins from the model's context. */
export const BUILT_IN_TOOLS: readonly string[] = [
  ...new Set<string>([...BUILTIN_TOOL_NAMES, 'BashOutput', 'KillBash', 'MultiEdit', 'Task']),
]

export interface SdkOptionsInput {
  model: string
  systemPrompt: string
  maxTurns: number
  /** Model-facing tool names, without the mcp prefix. */
  toolNames: readonly string[]
  mcpServer: McpSdkServerConfigWithInstance
  cwd: string
  apiKey: string
  abortController: AbortController
  pathEnv?: string
  onToolDenied?: (toolName: string) => void
}

export function buildSandboxEnv(input: { cwd: string; apiKey: string; pathEnv?: string }): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: input.apiKey,
    PATH: input.pathEnv ?? '/usr/bin:/bin',
    HOME: input.cwd,
    TMPDIR: input.cwd,
    CLAUDE_CONFIG_DIR: `${input.cwd}/.claude-config`,
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_CRON: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  }
}

const DENY_REASON = 'Only Relay tools are available in this run.'

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/

export function buildSdkOptions(input: SdkOptionsInput): Options {
  const bad = input.toolNames.find((n) => !TOOL_NAME.test(n))
  if (bad !== undefined) throw new Error(`invalid tool name: ${bad.slice(0, 80)}`)
  if (new Set(input.toolNames).size !== input.toolNames.length) throw new Error('duplicate tool name')
  const allowedTools = input.toolNames.map(mcpToolName)
  const allowSet = new Set(allowedTools)

  const canUseTool: CanUseTool = async (toolName) => {
    if (allowSet.has(toolName)) return { behavior: 'allow' }
    input.onToolDenied?.(toolName)
    return { behavior: 'deny', message: DENY_REASON }
  }

  const preToolUse: HookCallbackMatcher = {
    hooks: [
      async (hook) => {
        if (hook.hook_event_name !== 'PreToolUse' || allowSet.has(hook.tool_name)) return {}
        input.onToolDenied?.(hook.tool_name)
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: DENY_REASON,
          },
        }
      },
    ],
  }

  return {
    model: input.model,
    systemPrompt: input.systemPrompt,
    maxTurns: input.maxTurns,
    abortController: input.abortController,
    cwd: input.cwd,
    env: buildSandboxEnv(input),
    tools: [],
    allowedTools,
    disallowedTools: [...BUILT_IN_TOOLS],
    permissionMode: 'dontAsk',
    canUseTool,
    hooks: { PreToolUse: [preToolUse] },
    mcpServers: { [MCP_SERVER_NAME]: input.mcpServer },
    strictMcpConfig: true,
    settingSources: [],
    skills: [],
    plugins: [],
    persistSession: false,
    includePartialMessages: false,
  }
}
