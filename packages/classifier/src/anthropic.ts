import Anthropic, { APIConnectionTimeoutError, APIUserAbortError } from '@anthropic-ai/sdk'
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import { z } from 'zod'
import { buildClassifierSystem, buildClassifierUser } from './prompt'
import { CLASSIFIER_MODEL, type Classifier, type ClassifyInput, type ClassifyResult } from './types'

export const CLASSIFIER_MAX_TOKENS = 100
export const CLASSIFIER_TIMEOUT_MS = 5_000
export const CLASSIFIER_MAX_RETRIES = 1
export const CLASSIFIER_DEADLINE_MS = 12_000

export interface MessagesClient {
  messages: { create(params: MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message> }
}

export interface AnthropicClassifierOptions {
  /** Defaults to a real client built on first use. Tests pass a stub. */
  client?: MessagesClient
  getApiKey?: () => string | undefined
  model?: string
  deadlineMs?: number
}

const output = z.object({ routes: z.array(z.string()) })

export function buildClassifierRequest(input: ClassifyInput, model = CLASSIFIER_MODEL): MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: CLASSIFIER_MAX_TOKENS,
    thinking: { type: 'disabled' },
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { routes: { type: 'array', items: { type: 'string', enum: input.candidates.map((c) => c.label) } } },
          required: ['routes'],
          additionalProperties: false,
        },
      },
    },
    system: buildClassifierSystem(input.candidates),
    messages: [{ role: 'user', content: buildClassifierUser(input) }],
  }
}

export function createAnthropicClassifier(opts: AnthropicClassifierOptions = {}): Classifier {
  const model = opts.model ?? CLASSIFIER_MODEL
  const getApiKey = opts.getApiKey ?? (() => process.env.ANTHROPIC_API_KEY)
  let client = opts.client
  const getClient = (): MessagesClient | null => {
    if (client) return client
    const apiKey = getApiKey()
    if (!apiKey) return null
    client = new Anthropic({ apiKey, timeout: CLASSIFIER_TIMEOUT_MS, maxRetries: CLASSIFIER_MAX_RETRIES })
    return client
  }

  return {
    async classify(input) {
      const fail = (outcome: ClassifyResult['outcome'], error: string, usage = { inputTokens: 0, outputTokens: 0 }): ClassifyResult => ({
        outcome,
        labels: [],
        error,
        model,
        usage,
      })
      const c = getClient()
      if (!c) return fail('error', 'missing_api_key')
      let msg: Anthropic.Message
      try {
        msg = await c.messages.create(buildClassifierRequest(input, model), { signal: AbortSignal.timeout(opts.deadlineMs ?? CLASSIFIER_DEADLINE_MS) })
      } catch (err) {
        if (err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError) return fail('timeout', 'timeout')
        const status = (err as { status?: unknown }).status
        return fail('error', typeof status === 'number' ? `http_${status}` : err instanceof Error ? err.name : 'unknown')
      }
      const usage = { inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0 }
      if (msg.stop_reason === 'refusal') return fail('refusal', 'refusal', usage)
      if (msg.stop_reason === 'max_tokens') return fail('invalid', 'max_tokens', usage)
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      let parsed: z.infer<typeof output>
      try {
        parsed = output.parse(JSON.parse(text))
      } catch {
        return fail('invalid', 'unparseable_output', usage)
      }
      return { outcome: 'ok', labels: [...new Set(parsed.routes.map((l) => l.trim().toLowerCase()))], model, usage }
    },
  }
}
