import { randomBytes } from 'node:crypto'
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { agentConfigSchema, type AgentConfig } from './agent-config'
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_AGENT_TOOL_DESTINATIONS,
  MAX_TOOL_TIMEOUT_MS,
  toolConfigSchema,
  type ToolConfig,
} from './tool-config'
import type { Cipher } from './crypto'
import type { Db } from './db/client'
import {
  deliveries,
  connections,
  destinations,
  events,
  routeDestinations,
  routes,
  type DestinationRow,
  type RouteRow,
} from './db/schema'
import { QUEUES, type DispatchJob, type Queue, type RouteJob } from './queue'
import { MAX_REGEX_LENGTH, validateRegex } from './routing'

export const destinationUrl = z.url().refine((u) => /^https?:\/\//.test(u), 'must be http or https')

export const createDestinationInput = z.object({
  name: z.string().min(1),
  url: destinationUrl,
  maxAttempts: z.number().int().min(1).max(50).default(8),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  allowedActions: z.array(z.string().min(1)).nullable().default(null),
})
export type CreateDestinationInput = z.input<typeof createDestinationInput>

export const createAgentDestinationInput = z.object({
  name: z.string().min(1),
  config: agentConfigSchema,
  allowedActions: z.array(z.string().min(1)).nullable().default(null),
})
export type CreateAgentDestinationInput = z.input<typeof createAgentDestinationInput>

async function assertToolRefs(db: Pick<Db, 'select'>, connectionId: string, ids: readonly string[]) {
  if (ids.length === 0) return
  const unique = [...new Set(ids)]
  const found = await db
    .select({ id: destinations.id })
    .from(destinations)
    .where(and(inArray(destinations.id, unique), eq(destinations.connectionId, connectionId), eq(destinations.kind, 'tool')))
  if (found.length !== unique.length) throw new AdminError('unknown tool destination id', 'invalid')
}

export async function createAgentDestination(db: Db, connectionId: string, input: CreateAgentDestinationInput): Promise<DestinationRow> {
  const parsed = createAgentDestinationInput.parse(input)
  await assertToolRefs(db, connectionId, parsed.config.toolDestinationIds)
  const [destination] = await db
    .insert(destinations)
    .values({ connectionId, name: parsed.name, kind: 'agent', config: parsed.config, allowedActions: parsed.allowedActions })
    .returning()
  return destination!
}

export async function createDestination(
  db: Db,
  cipher: Cipher,
  connectionId: string,
  input: CreateDestinationInput,
): Promise<{ destination: DestinationRow; secret: string }> {
  const parsed = createDestinationInput.parse(input)
  const secret = randomBytes(32).toString('hex')
  const [destination] = await db
    .insert(destinations)
    .values({
      connectionId,
      name: parsed.name,
      url: parsed.url,
      maxAttempts: parsed.maxAttempts,
      timeoutMs: parsed.timeoutMs,
      allowedActions: parsed.allowedActions,
      secretCiphertext: cipher.encrypt(secret),
    })
    .returning()
  return { destination: destination!, secret }
}

export const createToolDestinationInput = toolConfigSchema.extend({
  name: z.string().min(1),
  url: destinationUrl,
  timeoutMs: z.number().int().min(100).max(MAX_TOOL_TIMEOUT_MS).default(DEFAULT_TOOL_TIMEOUT_MS),
})
export type CreateToolDestinationInput = z.input<typeof createToolDestinationInput>

async function assertToolNameFree(db: Pick<Db, 'select'>, connectionId: string, toolName: string, exceptId?: string) {
  const [row] = await db
    .select({ id: destinations.id })
    .from(destinations)
    .where(
      and(
        eq(destinations.connectionId, connectionId),
        eq(destinations.kind, 'tool'),
        sql`${destinations.config}->>'toolName' = ${toolName}`,
        ...(exceptId ? [sql`${destinations.id} <> ${exceptId}`] : []),
      ),
    )
  if (row) throw new AdminError(`tool name ${toolName} is already used in this connection`, 'conflict')
}

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && ((err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505')

export async function createToolDestination(
  db: Db,
  cipher: Cipher,
  connectionId: string,
  input: CreateToolDestinationInput,
): Promise<{ destination: DestinationRow; secret: string }> {
  const { name, url, timeoutMs, ...rest } = createToolDestinationInput.parse(input)
  const config: ToolConfig = toolConfigSchema.parse(rest)
  await assertToolNameFree(db, connectionId, config.toolName)
  const secret = randomBytes(32).toString('hex')
  try {
    const [destination] = await db
      .insert(destinations)
      .values({ connectionId, name, kind: 'tool', url, timeoutMs, maxAttempts: 1, config, secretCiphertext: cipher.encrypt(secret) })
      .returning()
    return { destination: destination!, secret }
  } catch (err) {
    if (isUniqueViolation(err)) throw new AdminError(`tool name ${config.toolName} is already used in this connection`, 'conflict')
    throw err
  }
}

export const MAX_INTENT_LENGTH = 500
export const MAX_ACTOR_IN = 100
export const MAX_ACTOR_ID_LENGTH = 200

export const createRouteFields = z.object({
  name: z.string().min(1),
  eventType: z.string().min(1),
  destinationIds: z.array(z.uuid()).min(1),
  textContains: z.string().min(1).nullable().default(null),
  textRegex: z
    .string()
    .min(1)
    .max(MAX_REGEX_LENGTH)
    .nullable()
    .default(null)
    .superRefine((value, ctx) => {
      const problem = value === null ? null : validateRegex(value)
      if (problem) ctx.addIssue({ code: 'custom', message: problem })
    }),
  includeSubtypes: z.boolean().default(false),
  enabled: z.boolean().default(true),
  selection: z.enum(['always', 'classifier']).optional(),
  intent: z
    .string()
    .trim()
    .max(MAX_INTENT_LENGTH)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v)),
  classifierFallback: z.enum(['drop', 'deliver']).optional(),
  actorIn: z
    .array(z.string().trim().min(1).max(MAX_ACTOR_ID_LENGTH))
    .max(MAX_ACTOR_IN)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null || v.length === 0 ? null : [...new Set(v)])),
})

export const createRouteInput = createRouteFields.superRefine((v, ctx) => {
  if (v.selection === 'classifier' && !v.intent) ctx.addIssue({ code: 'custom', path: ['intent'], message: 'a classifier route needs an intent' })
})
export type CreateRouteInput = z.input<typeof createRouteInput>

export const classifierSettingsInput = z
  .object({
    mode: z.enum(['off', 'shadow', 'enforce']),
    dailyLimit: z.number().int().min(0).max(100_000),
  })
  .strict()
export type ClassifierSettingsInput = z.input<typeof classifierSettingsInput>

export async function setClassifierSettings(db: Db, connectionId: string, input: ClassifierSettingsInput) {
  const p = classifierSettingsInput.parse(input)
  const [row] = await db
    .update(connections)
    .set({ classifierMode: p.mode, classifierDailyLimit: p.dailyLimit, updatedAt: sql`now()` })
    .where(eq(connections.id, connectionId))
    .returning({ mode: connections.classifierMode, dailyLimit: connections.classifierDailyLimit })
  if (!row) throw new AdminError('connection not found', 'not_found')
  return row
}

async function assertRouteRefs(db: Pick<Db, 'select'>, connectionId: string, destinationIds: string[]) {
  const unique = [...new Set(destinationIds)]
  const found = await db
    .select({ id: destinations.id, kind: destinations.kind })
    .from(destinations)
    .where(and(inArray(destinations.id, unique), eq(destinations.connectionId, connectionId)))
  if (found.length !== unique.length) throw new AdminError('unknown destination id', 'invalid')
  if (found.some((d) => d.kind === 'tool')) throw new AdminError('a tool destination is called by agents and cannot be linked to a route', 'invalid')
}

export async function createRoute(db: Db, connectionId: string, input: CreateRouteInput): Promise<RouteRow> {
  const parsed = createRouteInput.parse(input)
  await assertRouteRefs(db, connectionId, parsed.destinationIds)
  return db.transaction(async (tx) => {
    const [route] = await tx
      .insert(routes)
      .values({
        name: parsed.name,
        eventType: parsed.eventType,
        connectionId,
        textContains: parsed.textContains,
        textRegex: parsed.textRegex,
        includeSubtypes: parsed.includeSubtypes,
        enabled: parsed.enabled,
        selection: parsed.selection,
        intent: parsed.intent,
        classifierFallback: parsed.classifierFallback,
        actorIn: parsed.actorIn ?? null,
      })
      .returning()
    await tx
      .insert(routeDestinations)
      .values([...new Set(parsed.destinationIds)].map((destinationId) => ({ routeId: route!.id, destinationId })))
    return route!
  })
}

export async function updateRoute(db: Db, connectionId: string, id: string, input: CreateRouteInput): Promise<RouteRow> {
  const parsed = createRouteInput.parse(input)
  await assertRouteRefs(db, connectionId, parsed.destinationIds)
  return db.transaction(async (tx) => {
    const inTenant = and(eq(routes.id, id), eq(routes.connectionId, connectionId))
    const [existing] = await tx.select({ selection: routes.selection, intent: routes.intent }).from(routes).where(inTenant).for('update')
    if (!existing) throw new AdminError('route not found', 'not_found')
    const selection = parsed.selection ?? existing.selection
    const intent = parsed.intent !== undefined ? parsed.intent : existing.intent
    if (selection === 'classifier' && !intent) throw new AdminError('a classifier route needs an intent', 'invalid')
    const [route] = await tx
      .update(routes)
      .set({
        name: parsed.name,
        eventType: parsed.eventType,
        textContains: parsed.textContains,
        textRegex: parsed.textRegex,
        includeSubtypes: parsed.includeSubtypes,
        enabled: parsed.enabled,
        selection,
        intent,
        ...(parsed.classifierFallback !== undefined && { classifierFallback: parsed.classifierFallback }),
        ...(parsed.actorIn !== undefined && { actorIn: parsed.actorIn }),
        updatedAt: new Date(),
      })
      .where(inTenant)
      .returning()
    if (!route) throw new AdminError('route not found', 'not_found')
    await tx.delete(routeDestinations).where(eq(routeDestinations.routeId, id))
    await tx
      .insert(routeDestinations)
      .values([...new Set(parsed.destinationIds)].map((destinationId) => ({ routeId: id, destinationId })))
    return route
  })
}

export async function setRouteEnabled(db: Db, connectionId: string, id: string, enabled: boolean): Promise<RouteRow> {
  const [route] = await db
    .update(routes)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(routes.id, id), eq(routes.connectionId, connectionId)))
    .returning()
  if (!route) throw new AdminError('route not found', 'not_found')
  return route
}

export async function deleteRoute(db: Db, connectionId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: routes.id })
      .from(routes)
      .where(and(eq(routes.id, id), eq(routes.connectionId, connectionId)))
    if (!row) throw new AdminError('route not found', 'not_found')
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(deliveries).where(eq(deliveries.routeId, id))
    if (n > 0) throw new AdminError('route has deliveries; disable it instead', 'conflict')
    await tx.delete(routes).where(eq(routes.id, id))
  })
}

export const updateHttpDestinationInput = z
  .object({
    name: z.string().min(1).optional(),
    url: destinationUrl.optional(),
    enabled: z.boolean().optional(),
    maxAttempts: z.number().int().min(1).max(50).optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
    allowedActions: z.array(z.string().min(1)).nullable().optional(),
  })
  .strict()

const agentConfigPatch = z
  .object({
    systemPrompt: agentConfigSchema.shape.systemPrompt.optional(),
    model: agentConfigSchema.shape.model.removeDefault().optional(),
    maxTurns: agentConfigSchema.shape.maxTurns.removeDefault().optional(),
    timeoutSeconds: agentConfigSchema.shape.timeoutSeconds.removeDefault().optional(),
    maxMutatingActions: agentConfigSchema.shape.maxMutatingActions.removeDefault().optional(),
    toolDestinationIds: z.array(z.uuid()).max(MAX_AGENT_TOOL_DESTINATIONS).optional(),
  })
  .strict()

export const updateToolDestinationInput = z
  .object({
    name: z.string().min(1).optional(),
    url: destinationUrl.optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(MAX_TOOL_TIMEOUT_MS).optional(),
    toolName: toolConfigSchema.shape.toolName.optional(),
    description: toolConfigSchema.shape.description.optional(),
    params: toolConfigSchema.shape.params.optional(),
    mutating: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    maxResponseBytes: toolConfigSchema.shape.maxResponseBytes.removeDefault().optional(),
  })
  .strict()

export const updateAgentDestinationInput = z
  .object({
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    allowedActions: z.array(z.string().min(1)).nullable().optional(),
    config: agentConfigPatch.optional(),
  })
  .strict()

export async function updateDestination(db: Db, connectionId: string, id: string, input: unknown): Promise<DestinationRow> {
  const inTenant = and(eq(destinations.id, id), eq(destinations.connectionId, connectionId))
  const [existing] = await db.select().from(destinations).where(inTenant)
  if (!existing) throw new AdminError('destination not found', 'not_found')
  const set: Partial<typeof destinations.$inferInsert> = { updatedAt: new Date() }
  if (existing.kind === 'http') {
    const p = updateHttpDestinationInput.parse(input)
    Object.assign(set, {
      ...(p.name !== undefined && { name: p.name }),
      ...(p.url !== undefined && { url: p.url }),
      ...(p.enabled !== undefined && { enabled: p.enabled }),
      ...(p.maxAttempts !== undefined && { maxAttempts: p.maxAttempts }),
      ...(p.timeoutMs !== undefined && { timeoutMs: p.timeoutMs }),
      ...(p.allowedActions !== undefined && { allowedActions: p.allowedActions }),
    })
  } else if (existing.kind === 'tool') {
    const { name, url, enabled, timeoutMs, ...cfg } = updateToolDestinationInput.parse(input)
    Object.assign(set, {
      ...(name !== undefined && { name }),
      ...(url !== undefined && { url }),
      ...(enabled !== undefined && { enabled }),
      ...(timeoutMs !== undefined && { timeoutMs }),
    })
    const defined = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined))
    if (Object.keys(defined).length > 0) {
      const merged: ToolConfig = toolConfigSchema.parse({ ...(existing.config as object), ...defined })
      if (merged.toolName !== (existing.config as { toolName?: string } | null)?.toolName) await assertToolNameFree(db, connectionId, merged.toolName, id)
      set.config = merged
    }
  } else {
    const p = updateAgentDestinationInput.parse(input)
    Object.assign(set, {
      ...(p.name !== undefined && { name: p.name }),
      ...(p.enabled !== undefined && { enabled: p.enabled }),
      ...(p.allowedActions !== undefined && { allowedActions: p.allowedActions }),
    })
    if (p.config !== undefined) {
      const merged: AgentConfig = agentConfigSchema.parse({ ...(existing.config as object), ...p.config })
      await assertToolRefs(db, connectionId, merged.toolDestinationIds)
      set.config = merged
    }
  }
  let row: DestinationRow | undefined
  try {
    ;[row] = await db.update(destinations).set(set).where(inTenant).returning()
  } catch (err) {
    if (isUniqueViolation(err)) throw new AdminError('tool name is already used in this connection', 'conflict')
    throw err
  }
  if (!row) throw new AdminError('destination not found', 'not_found')
  return row
}

export async function deleteDestination(db: Db, connectionId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: destinations.id })
      .from(destinations)
      .where(and(eq(destinations.id, id), eq(destinations.connectionId, connectionId)))
    if (!row) throw new AdminError('destination not found', 'not_found')
    const [{ n: linked } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(routeDestinations)
      .where(eq(routeDestinations.destinationId, id))
    if (linked > 0) throw new AdminError(`destination is used by ${linked} route(s); unlink it first`, 'conflict')
    const [{ n: delivered } = { n: 0 }] = await tx.select({ n: count() }).from(deliveries).where(eq(deliveries.destinationId, id))
    if (delivered > 0) throw new AdminError('destination has deliveries; disable it instead', 'conflict')
    const [{ n: agents } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(destinations)
      .where(and(eq(destinations.kind, 'agent'), sql`coalesce(${destinations.config}->'toolDestinationIds', '[]'::jsonb) ? ${id}`))
    if (agents > 0) throw new AdminError(`destination is a tool of ${agents} agent(s); remove it there first`, 'conflict')
    await tx.delete(destinations).where(eq(destinations.id, id))
  })
}

export async function rotateDestinationSecret(db: Db, cipher: Cipher, connectionId: string, id: string): Promise<string> {
  const inTenant = and(eq(destinations.id, id), eq(destinations.connectionId, connectionId))
  const [existing] = await db.select({ kind: destinations.kind }).from(destinations).where(inTenant)
  if (!existing) throw new AdminError('destination not found', 'not_found')
  if (existing.kind === 'agent') throw new AdminError('only http and tool destinations have a signing secret', 'invalid')
  const secret = randomBytes(32).toString('hex')
  await db
    .update(destinations)
    .set({ secretCiphertext: cipher.encrypt(secret), updatedAt: new Date() })
    .where(inTenant)
  return secret
}

export async function revokeConnection(db: Db, id: string): Promise<void> {
  const rows = await db
    .update(connections)
    .set({ status: 'revoked', updatedAt: sql`now()` })
    .where(eq(connections.id, id))
    .returning({ id: connections.id })
  if (rows.length === 0) throw new AdminError('connection not found', 'not_found')
}

export type AdminErrorKind = 'not_found' | 'conflict' | 'invalid'

export class AdminError extends Error {
  override name = 'AdminError'
  constructor(
    message: string,
    readonly kind: AdminErrorKind,
  ) {
    super(message)
  }
}

export class ReplayError extends AdminError {
  override name = 'ReplayError'
  constructor(message: string, kind: AdminErrorKind = 'conflict') {
    super(message, kind)
  }
}

export async function replayDelivery(db: Db, queue: Queue, connectionId: string, deliveryId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const inTenant = tx.select({ id: events.id }).from(events).where(eq(events.connectionId, connectionId))
    const [row] = await tx
      .update(deliveries)
      .set({
        status: 'pending',
        attempts: 0,
        lastStatusCode: null,
        lastError: null,
        responseBody: null,
        nextAttemptAt: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, 'failed'), inArray(deliveries.eventId, inTenant)))
      .returning({ id: deliveries.id })
    if (!row) throw new ReplayError('delivery not found or not in failed status')
    await queue.send<DispatchJob>(QUEUES.dispatch, { deliveryId }, { tx, singletonKey: deliveryId })
  })
}

export async function replayEvent(db: Db, queue: Queue, connectionId: string, eventId: string): Promise<void> {
  const [event] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.connectionId, connectionId)))
  if (!event) throw new ReplayError('event not found', 'not_found')
  await queue.send<RouteJob>(QUEUES.route, { eventId }, { singletonKey: eventId })
}
