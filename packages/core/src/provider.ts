import type { Envelope } from './envelope'

export type ProviderId = 'slack' | 'webhook'
export type ConnectionStatus = 'active' | 'revoked'

export interface Connection {
  id: string
  provider: string
  teamId: string | null
  userId: string | null
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

export type ActionHandler = (ctx: { envelope: Envelope; connection: Connection }, params: unknown) => Promise<unknown>

export interface ProviderAdapter {
  id: ProviderId
  oauth?: OAuthConfig
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
  /** M3. */
  actions: Record<string, ActionHandler>
  /** M3. */
  isSelfEcho(envelope: Envelope, connection: Connection): Promise<boolean>
}

export const notImplemented = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not implemented yet`)
}
