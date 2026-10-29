import { z } from 'zod'

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,47}$/
export const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
export const MAX_TOOL_PARAMS = 20
export const MAX_TOOL_STRING_LENGTH = 4000
export const MAX_TOOL_ARRAY_ITEMS = 50
export const MAX_TOOL_ENUM_VALUES = 50
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000
export const MAX_TOOL_TIMEOUT_MS = 30_000
export const DEFAULT_TOOL_RESPONSE_BYTES = 32 * 1024
export const MAX_TOOL_RESPONSE_BYTES = 256 * 1024
export const MAX_TOOL_REQUEST_BYTES = 64 * 1024
export const MAX_AGENT_TOOL_DESTINATIONS = 20

/** Model-facing names of relay's own action tools, now and planned. A tool destination may not use them. */
export const RESERVED_TOOL_NAMES: readonly string[] = [
  'reply',
  'post',
  'react',
  'update',
  'thread_history',
  'send',
  'delete',
  'edit',
  'history',
  'unreact',
]

const description = z.string().min(1).max(500).optional()

const stringProp = z
  .object({
    type: z.literal('string'),
    description,
    enum: z.array(z.string().min(1).max(200)).min(1).max(MAX_TOOL_ENUM_VALUES).optional(),
    minLength: z.number().int().min(0).max(MAX_TOOL_STRING_LENGTH).optional(),
    maxLength: z.number().int().min(1).max(MAX_TOOL_STRING_LENGTH).optional(),
  })
  .strict()

const numberFields = {
  description,
  enum: z.array(z.number()).min(1).max(MAX_TOOL_ENUM_VALUES).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
}
const numberProp = z.object({ type: z.literal('number'), ...numberFields }).strict()
const integerProp = z.object({ type: z.literal('integer'), ...numberFields }).strict()
const booleanProp = z.object({ type: z.literal('boolean'), description }).strict()

const primitiveProp = z.discriminatedUnion('type', [stringProp, numberProp, integerProp, booleanProp])

const arrayProp = z
  .object({
    type: z.literal('array'),
    description,
    items: primitiveProp,
    minItems: z.number().int().min(0).max(MAX_TOOL_ARRAY_ITEMS).optional(),
    maxItems: z.number().int().min(1).max(MAX_TOOL_ARRAY_ITEMS).optional(),
  })
  .strict()

export const toolParamSchema = z.discriminatedUnion('type', [stringProp, numberProp, integerProp, booleanProp, arrayProp])
export type ToolParamSchema = z.output<typeof toolParamSchema>

export const toolParamsSchema = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string().regex(PARAM_NAME_RE, 'param names are letters, digits, and _'), toolParamSchema),
    required: z.array(z.string()).max(MAX_TOOL_PARAMS).optional(),
    additionalProperties: z.literal(false).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const names = Object.keys(v.properties)
    if (names.length > MAX_TOOL_PARAMS) ctx.addIssue({ code: 'custom', path: ['properties'], message: `at most ${MAX_TOOL_PARAMS} params` })
    for (const r of v.required ?? []) {
      if (!names.includes(r)) ctx.addIssue({ code: 'custom', path: ['required'], message: `required param ${r} is not in properties` })
    }
  })
export type ToolParams = z.output<typeof toolParamsSchema>

export const toolNameSchema = z
  .string()
  .regex(TOOL_NAME_RE, 'tool name is lowercase letters, digits, and _, starting with a letter, max 48')
  .refine((n) => !RESERVED_TOOL_NAMES.includes(n), 'tool name is reserved for a relay action')

export const toolConfigSchema = z
  .object({
    toolName: toolNameSchema,
    description: z.string().trim().min(1).max(1000),
    params: toolParamsSchema,
    mutating: z.boolean().default(true),
    sensitive: z.boolean().default(false),
    maxResponseBytes: z.number().int().min(1024).max(MAX_TOOL_RESPONSE_BYTES).default(DEFAULT_TOOL_RESPONSE_BYTES),
  })
  .strict()
export type ToolConfig = z.output<typeof toolConfigSchema>
export type ToolConfigInput = z.input<typeof toolConfigSchema>

function primitiveToZod(p: z.output<typeof primitiveProp>): z.ZodType {
  let out: z.ZodType
  if (p.type === 'string') {
    if (p.enum) out = z.enum(p.enum as [string, ...string[]])
    else {
      let s = z.string().max(Math.min(p.maxLength ?? MAX_TOOL_STRING_LENGTH, MAX_TOOL_STRING_LENGTH))
      if (p.minLength !== undefined) s = s.min(p.minLength)
      out = s
    }
  } else if (p.type === 'boolean') {
    out = z.boolean()
  } else if (p.enum) {
    out = z.literal(p.enum as [number, ...number[]])
  } else {
    let n = p.type === 'integer' ? z.number().int() : z.number()
    if (p.minimum !== undefined) n = n.min(p.minimum)
    if (p.maximum !== undefined) n = n.max(p.maximum)
    out = n
  }
  return p.description ? out.describe(p.description) : out
}

function examplePrimitive(p: z.output<typeof primitiveProp>): unknown {
  if (p.type === 'boolean') return false
  if (p.enum) return p.enum[0]
  if (p.type === 'string') return 'example'.padEnd(p.minLength ?? 0, 'x').slice(0, p.maxLength ?? MAX_TOOL_STRING_LENGTH)
  const lo = p.minimum ?? (p.maximum !== undefined ? Math.min(0, p.maximum) : 0)
  return p.type === 'integer' ? Math.ceil(lo) : lo
}

/** Smallest args that satisfy the required params. The fake agent runner uses it. */
export function exampleToolArgs(params: ToolParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const name of params.required ?? []) {
    const p = params.properties[name]
    if (!p) continue
    out[name] = p.type === 'array' ? Array.from({ length: p.minItems ?? 0 }, () => examplePrimitive(p.items)) : examplePrimitive(p)
  }
  return out
}

/** Builds the zod shape the SDK shows the model and the worker checks args against. */
export function toolParamsToZodShape(params: ToolParams): Record<string, z.ZodType> {
  const required = new Set(params.required ?? [])
  const shape: Record<string, z.ZodType> = {}
  for (const [name, p] of Object.entries(params.properties)) {
    let t: z.ZodType
    if (p.type === 'array') {
      let a = z.array(primitiveToZod(p.items)).max(Math.min(p.maxItems ?? MAX_TOOL_ARRAY_ITEMS, MAX_TOOL_ARRAY_ITEMS))
      if (p.minItems !== undefined) a = a.min(p.minItems)
      t = p.description ? a.describe(p.description) : a
    } else {
      t = primitiveToZod(p)
    }
    shape[name] = required.has(name) ? t : t.optional()
  }
  return shape
}
