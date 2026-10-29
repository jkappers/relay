import { existsSync } from 'node:fs'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { BUILT_IN_TOOLS, buildSdkOptions, mcpToolName } from '../src/options'

const mcpServer = createSdkMcpServer({ name: 'relay', tools: [] })
const build = (over: Partial<Parameters<typeof buildSdkOptions>[0]> = {}) =>
  buildSdkOptions({
    model: 'claude-sonnet-5-5',
    systemPrompt: 'sys',
    maxTurns: 8,
    toolNames: ['reply', 'thread_history'],
    mcpServer,
    cwd: '/tmp/relay-agent-test',
    apiKey: 'test-key',
    abortController: new AbortController(),
    pathEnv: '/usr/bin',
    ...over,
  })

describe('buildSdkOptions', () => {
  it('removes every built-in tool and allows only the relay tools', () => {
    const o = build()
    expect(o.tools).toEqual([])
    expect(o.allowedTools).toEqual([mcpToolName('reply'), mcpToolName('thread_history')])
    expect(o.allowedTools).toEqual(['mcp__relay__reply', 'mcp__relay__thread_history'])
    for (const name of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'Skill', 'TodoWrite']) {
      expect(o.disallowedTools).toContain(name)
      expect(BUILT_IN_TOOLS).toContain(name)
    }
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['relay'])
  })

  it('denies by default and never bypasses permissions', () => {
    const o = build()
    expect(o.permissionMode).toBe('dontAsk')
    expect(o).not.toHaveProperty('allowDangerouslySkipPermissions')
    expect(o.permissionMode).not.toBe('bypassPermissions')
  })

  it('canUseTool allows relay tools only, and reports denials', async () => {
    const denied: string[] = []
    const o = build({ onToolDenied: (n) => denied.push(n) })
    const opts = { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' } as never
    expect(await o.canUseTool!('mcp__relay__reply', {}, opts)).toEqual({ behavior: 'allow' })
    expect(await o.canUseTool!('Bash', { command: 'ls' }, opts)).toMatchObject({ behavior: 'deny' })
    expect(await o.canUseTool!('mcp__other__x', {}, opts)).toMatchObject({ behavior: 'deny' })
    expect(denied).toEqual(['Bash', 'mcp__other__x'])
  })

  it('a PreToolUse hook denies every other tool', async () => {
    const o = build()
    const hook = o.hooks!.PreToolUse![0]!.hooks[0]!
    const call = (tool_name: string) =>
      hook({ hook_event_name: 'PreToolUse', tool_name, tool_input: {}, tool_use_id: 'x' } as never, 'x', { signal: new AbortController().signal })
    expect(await call('mcp__relay__reply')).toEqual({})
    expect(await call('Read')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(await call('mcp__evil__tool')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('loads no ambient config', () => {
    const o = build()
    expect(o.settingSources).toEqual([])
    expect(o.strictMcpConfig).toBe(true)
    expect(o.skills).toEqual([])
    expect(o.plugins).toEqual([])
    expect(o.persistSession).toBe(false)
    expect(o).not.toHaveProperty('systemPrompt.preset')
    expect(typeof o.systemPrompt).toBe('string')
  })

  it('uses a temp cwd and an explicit minimal env', () => {
    const o = build()
    expect(o.cwd).toBe('/tmp/relay-agent-test')
    expect(Object.keys(o.env!).sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
        'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
        'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
        'CLAUDE_CODE_DISABLE_CRON',
        'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CONFIG_DIR',
        'ENABLE_TOOL_SEARCH',
        'HOME',
        'PATH',
        'TMPDIR',
      ].sort(),
    )
    expect(o.env!.HOME).toBe(o.cwd)
    expect(o.env!.CLAUDE_CONFIG_DIR?.startsWith(o.cwd!)).toBe(true)
    expect(o.env!.PATH).toBe('/usr/bin')
  })

  it('passes maxTurns, model, and the abort controller', () => {
    const ac = new AbortController()
    const o = build({ maxTurns: 3, abortController: ac })
    expect(o).toMatchObject({ maxTurns: 3, model: 'claude-sonnet-5-5', systemPrompt: 'sys' })
    expect(o.abortController).toBe(ac)
  })
})

describe('temp dir', () => {
  it('is not created by the pure builder', () => {
    expect(existsSync('/tmp/relay-agent-test')).toBe(false)
  })
})
