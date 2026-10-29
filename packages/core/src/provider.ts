import type { z } from 'zod'
import type { Credentials } from './connections'
import type { Envelope } from './envelope'

export type ProviderId = 'slack' | 'webhook' | 'sms' | 'discord'
export type ConnectionStatus = 'active' | 'revoked'

export interface Connection {
  id: string
  provider: string
  teamId: string | null
  userId: string | null
  name: string | null
  status: ConnectionStatus
  createdAt: Date
  updatedAt: Date
}

export class SignatureError extends Error {
  override name = 'SignatureError'
}

export class UnknownConnectionError extends Error {
  override name = 'UnknownConnectionError'
}

export class InvalidPayloadError extends Error {
  override name = 'InvalidPayloadError'
}

export interface IngressInput {
  req: Request
  rawBody: string
  payload: unknown
}

export interface ResolvedInput extends IngressInput {
  connection: Connection
}

export interface NormalizeInput extends ResolvedInput {
  eventId: string
  receivedAt: Date
}

export interface OAuthConfig {
  authorizeUrl: string
  userScopes: readonly string[]
}

/** A provider that delivers events over signed HTTP requests to /hooks/*. */
export interface ProviderAdapter {
  id: ProviderId
  oauth?: OAuthConfig
  /** How the request body is parsed into `payload`. Default 'json'. 'form' yields a string record. */
  bodyFormat?: 'json' | 'form'
  /** Response for an accepted or duplicate event. Default: empty 200. */
  ack?(): Response
  /** Throws SignatureError (401) or UnknownConnectionError (200, not stored). */
  verify(req: Request, rawBody: string): Promise<void>
  /** Runs after verify. A non-null Response is returned to the caller as-is. */
  handshake?(input: IngressInput): Response | null
  /** Provider control events (e.g. Slack tokens_revoked). Returns true when handled; the event is not stored. */
  lifecycle?(input: IngressInput): Promise<boolean>
  resolveConnection(input: IngressInput): Promise<Connection | null>
  dedupKey(input: ResolvedInput): string
  /** Envelope without `raw`; raw lives in events.raw. */
  normalize(input: NormalizeInput): Omit<Envelope, 'raw'>
}

/** One event from a provider's persistent socket (e.g. a Discord Gateway dispatch). The socket is authenticated, so there is no signature. */
export interface GatewayDispatch {
  /** Event name, e.g. MESSAGE_CREATE. */
  t: string
  d: unknown
}

export interface GatewayNormalizeInput {
  dispatch: GatewayDispatch
  connection: Connection
  eventId: string
  receivedAt: Date
}

export type GatewayLifecycleResult = { kind: 'revoked'; count: number }

export type GatewayResolution =
  | { kind: 'ignore'; reason: string }
  | { kind: 'ingest'; connections: Connection[]; reason?: string }

/** A provider that delivers events over a persistent socket held by apps/gateway. */
export interface GatewayAdapter {
  id: ProviderId
  /** Provider control events (e.g. Discord GUILD_DELETE). Returns null when the dispatch is not one. */
  lifecycle?(dispatch: GatewayDispatch): Promise<GatewayLifecycleResult | null>
  /** Which connections get this event. An empty list with `reason` means no connection matched. */
  resolveConnections(dispatch: GatewayDispatch): Promise<GatewayResolution>
  dedupKey(dispatch: GatewayDispatch, connection: Connection): string
  normalize(input: GatewayNormalizeInput): Omit<Envelope, 'raw'>
}

export class ActionError extends Error {
  override name = 'ActionError'
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code)
  }
}

export interface ActionContext {
  envelope: Envelope
  connection: Connection
  credentials: Credentials
  fetch: typeof fetch
}

export interface ActionOutput {
  result: unknown
  /** A message the action posted. Recorded in sent_messages with the action's log row. */
  sentMessage?: { channel: string; ts: string }
}

export interface ActionDef<S extends z.ZodType = z.ZodType> {
  mutating: boolean
  /** Tool description for agents. Falls back to a generic one per action name. */
  description?: string
  params: S
  run(ctx: ActionContext, params: z.output<S>): Promise<ActionOutput>
}

export function defineAction<S extends z.ZodType>(def: ActionDef<S>): ActionDef {
  return def as unknown as ActionDef
}

/** What the worker and the /actions route need. Holds no ingress secrets. */
export interface ProviderRuntime {
  id: ProviderId
  actions: Record<string, ActionDef>
  isSelfEcho(envelope: Envelope, connection: Connection): Promise<boolean>
  /**
   * The router waits and checks isSelfEcho again when the actor is the connection's own user, because the echo can
   * arrive before sent_messages is written. False for providers whose own posts never reach ingest (Discord bot).
   */
  echoRecheck?: boolean
}

/** Destination allow-list (null = all) intersected with what the runtime offers. */
export function computeAllowed(runtime: ProviderRuntime | undefined, destinationAllowed: readonly string[] | null): string[] {
  if (!runtime) return []
  const names = Object.keys(runtime.actions)
  return destinationAllowed ? names.filter((n) => destinationAllowed.includes(n)) : names
}
