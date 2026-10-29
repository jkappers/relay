import { randomBytes } from 'node:crypto'
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { agentConfigSchema, type AgentConfig } from './agent-config'
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

export const createDestinationInput = z.object({
  name: z.string().min(1),
  url: z
    .url()
    .refine((u) => /^https?:\/\//.test(u), 'must be http or https'),
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

export async function createAgentDestination(db: Db, input: CreateAgentDestinationInput): Promise<DestinationRow> {
  const parsed = createAgentDestinationInput.parse(input)
  const [destination] = await db
    .insert(destinations)
    .values({ name: parsed.name, kind: 'agent', config: parsed.config, allowedActions: parsed.allowedActions })
    .returning()
  return destination!
}

export async function createDestination(
  db: Db,
  cipher: Cipher,
  input: CreateDestinationInput,
): Promise<{ destination: DestinationRow; secret: string }> {
  const parsed = createDestinationInput.parse(input)
  const secret = randomBytes(32).toString('hex')
  const [destination] = await db
    .insert(destinations)
    .values({
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

export const createRouteInput = z.object({
  name: z.string().min(1),
  eventType: z.string().min(1),
  destinationIds: z.array(z.uuid()).min(1),
  connectionId: z.uuid().nullable().default(null),
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
})
export type CreateRouteInput = z.input<typeof createRouteInput>

async function assertRouteRefs(db: Pick<Db, 'select'>, destinationIds: string[], connectionId: string | null) {
  const unique = [...new Set(destinationIds)]
  const found = await db.select({ id: destinations.id }).from(destinations).where(inArray(destinations.id, unique))
  if (found.length !== unique.length) throw new AdminError('unknown destination id', 'invalid')
  if (connectionId !== null) {
    const [conn] = await db.select({ id: connections.id }).from(connections).where(eq(connections.id, connectionId))
    if (!conn) throw new AdminError('unknown connection id', 'invalid')
  }
}

export async function createRoute(db: Db, input: CreateRouteInput): Promise<RouteRow> {
  const parsed = createRouteInput.parse(input)
  await assertRouteRefs(db, parsed.destinationIds, parsed.connectionId)
  return db.transaction(async (tx) => {
    const [route] = await tx
      .insert(routes)
      .values({
        name: parsed.name,
        eventType: parsed.eventType,
        connectionId: parsed.connectionId,
        textContains: parsed.textContains,
        textRegex: parsed.textRegex,
        includeSubtypes: parsed.includeSubtypes,
        enabled: parsed.enabled,
      })
      .returning()
    await tx
      .insert(routeDestinations)
      .values([...new Set(parsed.destinationIds)].map((destinationId) => ({ routeId: route!.id, destinationId })))
    return route!
  })
}

export async function updateRoute(db: Db, id: string, input: CreateRouteInput): Promise<RouteRow> {
  const parsed = createRouteInput.parse(input)
  await assertRouteRefs(db, parsed.destinationIds, parsed.connectionId)
  return db.transaction(async (tx) => {
    const [route] = await tx
      .update(routes)
      .set({
        name: parsed.name,
        eventType: parsed.eventType,
        connectionId: parsed.connectionId,
        textContains: parsed.textContains,
        textRegex: parsed.textRegex,
        includeSubtypes: parsed.includeSubtypes,
        enabled: parsed.enabled,
        updatedAt: new Date(),
      })
      .where(eq(routes.id, id))
      .returning()
    if (!route) throw new AdminError('route not found', 'not_found')
    await tx.delete(routeDestinations).where(eq(routeDestinations.routeId, id))
    await tx
      .insert(routeDestinations)
      .values([...new Set(parsed.destinationIds)].map((destinationId) => ({ routeId: id, destinationId })))
    return route
  })
}

export async function setRouteEnabled(db: Db, id: string, enabled: boolean): Promise<RouteRow> {
  const [route] = await db.update(routes).set({ enabled, updatedAt: new Date() }).where(eq(routes.id, id)).returning()
  if (!route) throw new AdminError('route not found', 'not_found')
  return route
}

export async function deleteRoute(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ id: routes.id }).from(routes).where(eq(routes.id, id))
    if (!row) throw new AdminError('route not found', 'not_found')
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(deliveries).where(eq(deliveries.routeId, id))
    if (n > 0) throw new AdminError('route has deliveries; disable it instead', 'conflict')
    await tx.delete(routes).where(eq(routes.id, id))
  })
}

export const updateHttpDestinationInput = z
  .object({
    name: z.string().min(1).optional(),
    url: z.url().refine((u) => /^https?:\/\//.test(u), 'must be http or https').optional(),
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

export async function updateDestination(db: Db, id: string, input: unknown): Promise<DestinationRow> {
  const [existing] = await db.select().from(destinations).where(eq(destinations.id, id))
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
  } else {
    const p = updateAgentDestinationInput.parse(input)
    Object.assign(set, {
      ...(p.name !== undefined && { name: p.name }),
      ...(p.enabled !== undefined && { enabled: p.enabled }),
      ...(p.allowedActions !== undefined && { allowedActions: p.allowedActions }),
    })
    if (p.config !== undefined) {
      const merged: AgentConfig = agentConfigSchema.parse({ ...(existing.config as object), ...p.config })
      set.config = merged
    }
  }
  const [row] = await db.update(destinations).set(set).where(eq(destinations.id, id)).returning()
  return row!
}

export async function deleteDestination(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ id: destinations.id }).from(destinations).where(eq(destinations.id, id))
    if (!row) throw new AdminError('destination not found', 'not_found')
    const [{ n: linked } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(routeDestinations)
      .where(eq(routeDestinations.destinationId, id))
    if (linked > 0) throw new AdminError(`destination is used by ${linked} route(s); unlink it first`, 'conflict')
    const [{ n: delivered } = { n: 0 }] = await tx.select({ n: count() }).from(deliveries).where(eq(deliveries.destinationId, id))
    if (delivered > 0) throw new AdminError('destination has deliveries; disable it instead', 'conflict')
    await tx.delete(destinations).where(eq(destinations.id, id))
  })
}

export async function rotateDestinationSecret(db: Db, cipher: Cipher, id: string): Promise<string> {
  const [existing] = await db.select({ kind: destinations.kind }).from(destinations).where(eq(destinations.id, id))
  if (!existing) throw new AdminError('destination not found', 'not_found')
  if (existing.kind !== 'http') throw new AdminError('only http destinations have a signing secret', 'invalid')
  const secret = randomBytes(32).toString('hex')
  await db
    .update(destinations)
    .set({ secretCiphertext: cipher.encrypt(secret), updatedAt: new Date() })
    .where(eq(destinations.id, id))
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

export async function replayDelivery(db: Db, queue: Queue, deliveryId: string): Promise<void> {
  await db.transaction(async (tx) => {
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
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, 'failed')))
      .returning({ id: deliveries.id })
    if (!row) throw new ReplayError('delivery not found or not in failed status')
    await queue.send<DispatchJob>(QUEUES.dispatch, { deliveryId }, { tx, singletonKey: deliveryId })
  })
}

export async function replayEvent(db: Db, queue: Queue, eventId: string): Promise<void> {
  const [event] = await db.select({ id: events.id }).from(events).where(eq(events.id, eventId))
  if (!event) throw new ReplayError('event not found', 'not_found')
  await queue.send<RouteJob>(QUEUES.route, { eventId }, { singletonKey: eventId })
}
