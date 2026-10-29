import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { agentConfigSchema } from './agent-config'
import type { Cipher } from './crypto'
import type { Db } from './db/client'
import {
  deliveries,
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
})
export type CreateRouteInput = z.input<typeof createRouteInput>

export async function createRoute(db: Db, input: CreateRouteInput): Promise<RouteRow> {
  const parsed = createRouteInput.parse(input)
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
      })
      .returning()
    await tx
      .insert(routeDestinations)
      .values([...new Set(parsed.destinationIds)].map((destinationId) => ({ routeId: route!.id, destinationId })))
    return route!
  })
}

export class ReplayError extends Error {
  override name = 'ReplayError'
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
  if (!event) throw new ReplayError('event not found')
  await queue.send<RouteJob>(QUEUES.route, { eventId }, { singletonKey: eventId })
}
