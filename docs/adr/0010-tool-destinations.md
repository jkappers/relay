# ADR 0010: Tool destinations give agents operator-registered HTTP tools

Status: accepted (M11). Amends ADR 0004 ("relay actions are the only tools").

## Decision

Add a destination kind `tool`. A tool destination is an HTTP endpoint the operator registers in one connection. An agent destination in the same connection can list it in `config.toolDestinationIds`, and the agent then gets one extra tool for it. Relay actions are no longer the only tools: an agent's tools are relay actions plus the tool destinations the operator attached. Nothing else changes in ADR 0004. Built-in Claude Code tools stay off in every layer, and there is still no MCP server but relay's own in-process one.

Tool destinations are not MCP servers. Relay does not discover tools from the endpoint. The operator writes the name, description, and parameter schema, and relay owns the call.

No new dependency. The parameter schema is converted to zod (already used). Calls use `fetch` and the signing helper that HTTP destinations use.

## Fields

| Field | Rule |
|---|---|
| `url` | http or https, the same check as HTTP destinations. Fixed at write time. |
| secret | 32 random bytes, hex. Stored encrypted like HTTP destination secrets. Shown once. Rotatable. |
| `toolName` | `^[a-z][a-z0-9_]{0,47}$`, unique per connection, and not a reserved relay action tool name (`reply`, `post`, `react`, `update`, `thread_history`, `send`, ...). The model sees `mcp__relay__<toolName>`. |
| `description` | 1 to 1000 chars. Shown to the model. |
| `params` | A restricted JSON Schema: `{type: "object", properties, required?, additionalProperties?: false}`. Up to 20 properties. Each is `string`, `number`, `integer`, or `boolean` (with optional `enum`, `minLength`/`maxLength`, `minimum`/`maximum`, `description`), or an `array` of one of those (with `maxItems` up to 50). Anything else (`$ref`, nested objects, `oneOf`, formats, patterns, unknown keys) is rejected at write time. Strings are capped at 4000 chars even if the schema says more. |
| `mutating` | Whether a call changes something. Default true. |
| `sensitive` | Whether the tool needs a trusted actor. Default false. |
| `timeoutMs` | Default 10000, max 30000. |
| `maxResponseBytes` | Default 32768, max 262144. |

A tool destination never gets deliveries. Routes cannot link it, and the dispatcher fails a delivery to one (`not_deliverable`).

## How a call works

The SDK subprocess never makes the request. The tool is an in-process MCP tool (`tools.ts`), so the worker does it:

1. Args are checked against the zod schema again (strict: unknown keys are rejected), even though the SDK checks them first.
2. The body is `{tool: {name, call}, args, event, delivery: {id}, run: {id}}`. `event` is the stored envelope without `raw`. Args only ever go into the body. URL, method, and headers come from the stored destination.
3. Headers are the HTTP destination ones (`Relay-Delivery-Id`, `Relay-Event-Id`, `Relay-Timestamp`, `Relay-Signature` over `{timestamp}.{body}` with the destination secret, `User-Agent`), plus `Relay-Run-Id`, `Relay-Tool`, and `Idempotency-Key`.
4. The request body is capped at 64 KB (else `too_large`, not sent). `redirect: 'manual'`, so a 3xx is an error and never followed. The response is read up to `maxResponseBytes`; past that the read stops and the call is `too_large`.
5. The model gets a 2xx body (as text, cut to 16000 chars) inside a nonce-delimited block that says it is untrusted data from the tool. On failure it gets only a short code (`error: http_4xx (404)`, `error: timeout`, ...), never the upstream body.

## Limits and changes

- A `mutating` tool counts toward `maxMutatingActions`, shared with relay's mutating actions. Past the cap the call is refused and nothing is sent.
- Each mutating call writes an `actions_log` row with key `agent:<runId>:<n>` (the same counter as relay actions) and type `tool:<toolName>`, and sends that key as `Idempotency-Key`. Read-only calls send `agent:<runId>:r<n>` and write no row.
- After a 2xx, the row is `succeeded` and `agent_runs.mutated` is set in the same transaction, through the same hook relay actions use. After a timeout, network error, 5xx, or an oversize 2xx, relay cannot know whether the endpoint acted, so the row is marked `failed` with that error and `mutated` is set anyway. A 3xx or 4xx is `failed` and does not set `mutated`. So ADR 0004's rule holds: once a run may have changed something, it is never run again.
- Non-mutating tools do not count toward the cap. `maxTurns` and the run timeout still bound them.

## Sensitive tools

A `sensitive` tool is offered only when the route that made the delivery has a non-empty `actor_in` list that holds the event's `actor`. With no `actor_in` on that route, sensitive tools are never offered. The check runs when the run is built, so a withheld tool is absent from the tool list and the system prompt. The model cannot ask for it.

`actor_in` is only as strong as the provider's actor (see README): Slack and Discord set it from signed events; SMS uses an unverified `From` number.

## Tenancy

`toolDestinationIds` is checked when an agent destination is written (each id must be a `tool` destination in the same connection) and again on every run. At run time an id in another connection is skipped and counted in `relay_cross_tenant_blocked_total{stage="agent_tool"}`. Missing, disabled, invalid, or colliding tools are skipped and counted in `relay_agent_tools_withheld_total`. A tool destination that an agent lists cannot be deleted.

## Residual risk

Injected event text can make the agent call an attached tool with args of its choosing, up to the cap. The operator decides which tools an agent has, and should treat every arg as attacker-controlled. The endpoint should verify the signature and validate args itself. Mark anything that reads private data or acts with real authority `sensitive` and put an `actor_in` list on the route.
