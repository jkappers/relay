# ADR 0009: Classifier routing with the plain Anthropic SDK

Status: accepted (M9)

## Decision

A route can be gated by an LLM classifier. Add `@anthropic-ai/sdk` (1.3.0, exact pin) as a direct dependency of the new `packages/classifier`. It was already in the lockfile as a peer of the Agent SDK (peer range `>=0.93.0`), so the same version is used in both places.

## Why the plain SDK, not the Agent SDK

The classifier makes one call per event, with no tools and no loop. The Agent SDK starts a Claude Code subprocess per run and ships built-in tools that would all need removing (ADR 0004). A single `messages.create` call has no tools by construction, starts no process, and returns in about a second.

## Shape of the call

- Model `claude-haiku-5-5`, `max_tokens` 100.
- Structured output: `output_config.format = {type: 'json_schema', schema}`. The schema is an object with one field, `routes`, an array of strings whose `enum` is the candidate labels. `additionalProperties: false`. No `maxItems` (not supported by structured outputs).
- `thinking: {type: 'disabled'}` and `output_config.effort: 'low'`. Haiku 5.5 thinks by default, and thinking tokens count toward `max_tokens`, so a 100-token budget would truncate.
- No `temperature`, `top_p`, or `top_k`. Haiku 5.5 rejects non-default values.
- Client options `timeout: 5000`, `maxRetries: 1`. In SDK 1.3.0 the timeout is per attempt (each retry arms its own timer around `fetch`) and a timeout throws `APIConnectionTimeoutError`. A hard overall deadline (`AbortSignal`) of 12 s caps retries plus backoff.

## Safety

The event text is untrusted, so we assume the model can be talked into any answer. The controls do not depend on it:

- **Narrow only.** The deterministic router picks the candidate routes first. The classifier only decides which of the matched `classifier` routes get the event. Routes with selection `always` are never shown to it and always deliver. It cannot add a route, pick a destination, or see a URL.
- **Opaque labels.** Candidates are shown as `r1..rn` plus the operator's `intent` (max 500 chars). The enum limits the output to those labels. Labels outside the candidate set are discarded anyway, case-insensitively.
- The event sits in a nonce-delimited JSON block (text cut to 4000 chars). The instruction part holds only labels and intents.
- Echoes and the loop guard run before the classifier. Echoes never reach it.
- A classifier route must never be the only guard in front of a high-risk destination. Use deterministic filters for that.

## Determinism

The first decision for an event is final. It is stored in `route_decisions` (unique on `event_id`), inserted with `ON CONFLICT DO NOTHING` in the same transaction that creates the deliveries, and read back in that transaction. Under READ COMMITTED a concurrent insert blocks ours until it commits, and the read then sees the winner. Retries, rechecks, sweeps, and replays reuse the stored row and make no call. The stored selection is intersected with the routes that match now, so a route disabled since then is not delivered. A gated route added after the decision is never delivered for that event (fail closed).

## Failures, budget, modes

- Timeout, API error, refusal (`stop_reason: 'refusal'`), truncation (`max_tokens`), or output that does not parse: each gated route uses its own `classifier_fallback` (`drop` by default, or `deliver`). The decision is stored with `status = 'fallback'`.
- Daily cap per connection (`classifier_daily_limit`, default 1000), counted from stored decisions since midnight UTC. Over the cap there is no call, the fallback applies, and the row has `status = 'budget_exceeded'`. Those rows do not count toward the cap. The count is not serialized, so concurrent first calls can overshoot by about the worker's concurrency.
- Connection `classifier_mode`: `off` (default; `classifier` routes act like `always`), `shadow` (call and record, but deliver every gated route), `enforce`.
- Worst case latency per event is about 11 s (two 5 s attempts plus backoff).

## Costs

You pay for the calls. Each is about one short prompt and a few output tokens. Tokens are stored on the decision row and counted in `relay_classifier_tokens_total`.

## Testing

Tests never call the API. The Anthropic implementation is tested with an injected stub client. `RELAY_CLASSIFIER=fake` uses a keyword-overlap classifier for demos, and is refused when `NODE_ENV=production`.
