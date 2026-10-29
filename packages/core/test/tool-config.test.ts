import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { exampleToolArgs, MAX_TOOL_STRING_LENGTH, toolConfigSchema, toolParamsSchema, toolParamsToZodShape, type ToolParams } from '../src'

const params: ToolParams = toolParamsSchema.parse({
  type: 'object',
  properties: {
    orderId: { type: 'string', minLength: 3, maxLength: 40, description: 'The order id' },
    note: { type: 'string' },
    status: { type: 'string', enum: ['open', 'closed'] },
    qty: { type: 'integer', minimum: 1, maximum: 10 },
    ratio: { type: 'number', enum: [0.5, 1] },
    urgent: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string', maxLength: 10 }, minItems: 1, maxItems: 3 },
  },
  required: ['orderId', 'status', 'qty', 'ratio', 'urgent', 'tags'],
  additionalProperties: false,
})

describe('tool params schema', () => {
  it('converts to a strict zod object with required and optional params', () => {
    const s = z.object(toolParamsToZodShape(params)).strict()
    const ok = { orderId: 'A-1', status: 'open', qty: 2, ratio: 0.5, urgent: true, tags: ['x'] }
    expect(s.safeParse(ok).success).toBe(true)
    expect(s.safeParse({ ...ok, note: 'hi' }).success).toBe(true)
    const bad = [
      { ...ok, orderId: 'A' },
      { ...ok, status: 'pending' },
      { ...ok, qty: 1.5 },
      { ...ok, qty: 11 },
      { ...ok, ratio: 0.7 },
      { ...ok, urgent: 'yes' },
      { ...ok, tags: [] },
      { ...ok, tags: ['a', 'b', 'c', 'd'] },
      { ...ok, tags: ['01234567890'] },
      { ...ok, url: 'http://evil.test' },
      (({ orderId: _o, ...rest }) => rest)(ok),
    ]
    for (const b of bad) expect(s.safeParse(b).success, JSON.stringify(b)).toBe(false)
  })

  it('caps strings even when the schema has no maxLength', () => {
    const s = z.object(toolParamsToZodShape(params)).strict()
    const base = { orderId: 'A-1', status: 'open', qty: 2, ratio: 0.5, urgent: true, tags: ['x'] }
    expect(s.safeParse({ ...base, note: 'x'.repeat(MAX_TOOL_STRING_LENGTH) }).success).toBe(true)
    expect(s.safeParse({ ...base, note: 'x'.repeat(MAX_TOOL_STRING_LENGTH + 1) }).success).toBe(false)
  })

  it('keeps descriptions for the model', () => {
    const json = z.toJSONSchema(z.object(toolParamsToZodShape(params))) as { properties: Record<string, { description?: string }> }
    expect(json.properties.orderId!.description).toBe('The order id')
  })

  it('example args satisfy the schema', () => {
    const s = z.object(toolParamsToZodShape(params)).strict()
    expect(s.safeParse(exampleToolArgs(params)).success).toBe(true)
  })

  it('rejects reserved names and odd fields', () => {
    const base = { toolName: 'lookup', description: 'd', params: { type: 'object', properties: {} } }
    expect(toolConfigSchema.parse(base)).toMatchObject({ mutating: true, sensitive: false, maxResponseBytes: 32768 })
    for (const toolName of ['reply', 'thread_history', 'send', 'Lookup', '1x', 'a-b', 'x'.repeat(49)]) {
      expect(toolConfigSchema.safeParse({ ...base, toolName }).success, toolName).toBe(false)
    }
    expect(toolConfigSchema.safeParse({ ...base, url: 'http://x' }).success).toBe(false)
  })
})
