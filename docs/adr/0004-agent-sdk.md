# ADR 0004: Agents run on the Claude Agent SDK, with relay actions as the only tools

Status: accepted (M4)

## Decision

Add `@anthropic-ai/claude-agent-sdk` (0.3.310, exact pin) to `packages/destinations/agent`. An `agent` destination runs a Claude agent in the worker process on each event. Its only tools are relay's own actions for that event.

The SDK needs `zod` (already used), `@anthropic-ai/sdk`, and `@modelcontextprotocol/sdk` as peer dependencies. pnpm installed the last two for us. They are not used directly. The SDK also ships a platform binary (the Claude Code runtime) as an optional dependency, and `query()` starts it as a subprocess.

## Why the Agent SDK

- It gives us the agent loop, turn limits, abort, and usage and cost reporting. We would otherwise rebuild these on the Messages API.
- In-process tools (`tool()` plus `createSdkMcpServer()`) let a tool call `executeActions` directly. No second server, no extra credentials.

## Why this is safe enough

The SDK is Claude Code as a library, so its defaults are the opposite of what we want: it has shell, file, and web tools and loads user and project config. Anyone who can message the user controls the event text, and that text may contain prompt injection. We assume the model can be talked into anything. So the controls do not depend on the model behaving.

Built-in tools are removed in several layers (docs: code.claude.com/docs/en/agent-sdk/custom-tools, `/permissions`, `/typescript`):

1. `tools: []` removes every built-in tool from the model's context.
2. `disallowedTools` lists the built-in names too (the SDK's own `BUILTIN_TOOL_NAMES` plus a few older ones).
3. `allowedTools` lists only the relay tools, by exact name (`mcp__relay__reply` and so on).
4. `permissionMode: 'dontAsk'` denies anything that would need approval.
5. A `PreToolUse` hook, which runs before every other check, denies any tool not on the list. A `canUseTool` callback does the same, as a backup.
6. `strictMcpConfig: true` means the only MCP server is ours.

Ambient config is off:

- `settingSources: []`, `skills: []`, `plugins: []`, `persistSession: false`.
- `cwd` is a fresh temp dir for each run, deleted afterward.
- `env` replaces the subprocess environment. It holds only the API key, `PATH`, and a few flags. `HOME` and `CLAUDE_CONFIG_DIR` point inside the temp dir, so user config on the host cannot be found. Auto-memory, CLAUDE.md loading, background tasks, cron, and non-essential traffic are switched off.

Scope comes from the actions layer, not the model:

- Each tool calls `executeActions` for this delivery only, so `allowed_actions` still applies. A tool for an action that is not allowed does not exist.
- Tool params are the runtime's own zod schemas. They have no channel or thread field. Targets come from the stored event.
- Limits: `maxTurns` (default 8), a wall-clock timeout (300 s, through an AbortController), and a cap on mutating actions (3). Past the cap, the tool returns an error and nothing is sent.
- The prompt says the event is untrusted data and sits in a delimited JSON block. This is a second line of defense, not the main control.
- The residual risk: injected text can make the agent post something silly in the source thread, as the user, up to the cap. It cannot reach anything else.

## No rerun after a change

An agent run is not idempotent. If we rerun it, the model may say something different, and Slack gets a second reply.

- `agent_runs.mutated` is set in the same transaction that records the first successful mutating action.
- A run that fails or crashes after that is never run again. It is marked `failed` with `error = 'not_retried_after_mutation'`.
- A mutating action left `pending` (the call may have reached Slack, but the response was lost) counts the same way.
- A run that fails before any change is retried up to 3 attempts with backoff. Timeouts and `max_turns` are not retried.
- Tool calls use idempotency keys `agent:<runId>:<n>`, so replays of the same call never post twice.
- A run holds a lease (`lease_until`, timeout plus 60 s). Only one worker can hold it, so a duplicate job or a sweep never starts a second concurrent run.

## Costs and trade-offs

- Runs cost money and take minutes, so they use their own queue (`agent`) and concurrency setting. HTTP deliveries are not blocked.
- The SDK starts a native subprocess for each run. That is acceptable at personal volume.
- We depend on the SDK's permission behavior. Tests pin our options, and an opt-in live test (`RELAY_LIVE_AGENT_TEST=1`) checks the real thing.

## Alternative

If the SDK ever cannot guarantee that built-in tools are off, use plain Messages API tool use. It has no built-in tools by construction. We would write the loop, the turn and time limits, and the usage accounting ourselves. The `AgentRunner` interface keeps this change inside one file.
