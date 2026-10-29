import type { DetailState, RoutedState } from './states'

export interface Issue {
  path: string
  message: string
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: Issue[] = [],
    readonly code: string | null = null,
    readonly body: unknown = null,
  ) {
    super(message)
  }

  describe(): string {
    if (this.issues.length === 0) return this.message
    return this.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')
  }
}

export const UNAUTHORIZED_EVENT = 'relay:unauthorized'
export const CONNECTIONS_CHANGED_EVENT = 'relay:connections-changed'
export const connectionsChanged = () => window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT))

let tenant: string | null = null

/** The connection the console is looking at. Tenant API calls go to /api/c/<id>/... */
export const setTenant = (id: string | null) => {
  tenant = id
}
export const currentTenant = () => tenant

const ACCOUNT_PATH = /^\/api\/(session|users|connections|tokens|admin\/|c\/)/

export function apiPath(path: string): string {
  if (!path.startsWith('/api/') || ACCOUNT_PATH.test(path)) return path
  if (!tenant) throw new ApiError('no connection selected', 0)
  return `/api/c/${tenant}${path.slice(4)}`
}

export async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Relay-Console': '1' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(apiPath(path), {
    method,
    headers,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 204) return undefined as T
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/session') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    const d = (data ?? {}) as { error?: string; message?: string; issues?: Issue[] }
    throw new ApiError(d.message ?? d.error ?? `request failed (${res.status})`, res.status, d.issues ?? [], d.error ?? null, data)
  }
  return data as T
}

export const get = <T>(path: string) => request<T>('GET', path)
export const post = <T = void>(path: string, body?: unknown) => request<T>('POST', path, body)
export const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body)
export const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body)
export const del = (path: string) => request<void>('DELETE', path)

export interface Connection {
  id: string
  name: string | null
  provider: string
  teamId: string | null
  userId: string | null
  status: 'active' | 'revoked'
  role: 'owner'
  createdAt: string
}

export type SignupMode = 'open' | 'closed'

export interface Session {
  user: { id: string; email: string; isAdmin: boolean }
  connections: Connection[]
  signup: SignupMode
  adminExists: boolean
}

/** OAuth start URLs for the installs the server is set up for. Null when the app settings are missing. */
export interface InstallUrls {
  slack: string | null
  discord: string | null
}

export interface WebhookCreated extends Omit<Connection, 'role' | 'teamId' | 'userId'> {
  url: string
  secret: string
}

export interface SmsCreated extends Omit<Connection, 'role' | 'teamId' | 'userId'> {
  url: string
}

export interface AgentConfig {
  systemPrompt: string
  model: string
  maxTurns: number
  timeoutSeconds: number
  maxMutatingActions: number
  toolDestinationIds?: string[]
}

export interface ToolConfig {
  toolName: string
  description: string
  params: unknown
  mutating: boolean
  sensitive: boolean
  maxResponseBytes: number
}

interface DestinationBase {
  id: string
  name: string
  url: string | null
  enabled: boolean
  maxAttempts: number
  timeoutMs: number
  allowedActions: string[] | null
  routeCount?: number
  createdAt: string
}

export type Destination =
  | (DestinationBase & { kind: 'http'; config: null })
  | (DestinationBase & { kind: 'agent'; config: AgentConfig })
  | (DestinationBase & { kind: 'tool'; config: ToolConfig })

export interface ToolCall {
  n: number
  type: string
  status: string
  error?: string
  destinationId?: string
  params?: unknown
  result?: unknown
}

export interface Route {
  id: string
  name: string
  connectionId: string
  eventType: string
  textContains: string | null
  textRegex: string | null
  includeSubtypes: boolean
  enabled: boolean
  selection: 'always' | 'classifier'
  intent: string | null
  classifierFallback: 'drop' | 'deliver'
  actorIn: string[] | null
  destinationIds: string[]
}

export type ClassifierMode = 'off' | 'shadow' | 'enforce'

export interface ClassifierSettings {
  mode: ClassifierMode
  dailyLimit: number
}

export interface RouteDecision {
  id: string
  mode: 'shadow' | 'enforce'
  model: string
  status: 'ok' | 'fallback' | 'budget_exceeded'
  error: string | null
  latencyMs: number
  inputTokens: number
  outputTokens: number
  createdAt: string
  candidates: { label: string; routeId: string; routeName: string | null; selected: boolean }[]
  selected: { routeId: string; routeName: string | null }[]
}

export interface EventSummary {
  id: string
  provider: string
  connectionId: string
  type: string
  subtype: string | null
  actor: string | null
  text: string | null
  receivedAt: string
  routedAt: string | null
  deliveryCount: number
  failedCount: number
  trace: EventTrace
}

export interface StatusCounts {
  pending: number
  succeeded: number
  failed: number
}

export type { RoutedState }

export interface EventTrace {
  routed: RoutedState
  deliveries: StatusCounts
  actions: StatusCounts
  failedDelivery: { id: string; lastError: string | null } | null
}

export interface EventPage {
  items: EventSummary[]
  nextCursor: string | null
}

export interface DeliveryRow {
  id: string
  eventId: string
  routeId: string
  destinationId: string
  status: 'pending' | 'succeeded' | 'failed'
  attempts: number
  lastStatusCode: number | null
  lastError: string | null
  responseBody: unknown
  nextAttemptAt: string | null
  createdAt: string
  completedAt: string | null
  lastReplyJti: string | null
  routeName: string
  destinationName: string
  destinationKind?: 'http' | 'agent' | 'tool'
  eventType?: string
}

export interface ActionRow {
  id: string
  type: string
  status: 'pending' | 'succeeded' | 'failed'
  attempts: number
  error: string | null
  createdAt: string
  [key: string]: unknown
}

export interface AgentRunRow {
  id: string
  status: 'running' | 'succeeded' | 'failed'
  turns: number
  inputTokens: number
  outputTokens: number
  costUsd: string
  error: string | null
  startedAt: string
  finishedAt: string | null
  toolCalls?: ToolCall[]
  [key: string]: unknown
}

export interface EventDetail {
  id: string
  provider: string
  connectionId: string
  receivedAt: string
  routedAt: string | null
  dedupKey: string
  state: DetailState
  echo: boolean
  classified: boolean
  routed: boolean
  envelope: unknown
  raw: unknown
  deliveries: DeliveryRow[]
  actions: ActionRow[]
  agentRuns: AgentRunRow[]
}

export interface Overview {
  windowHours: number
  events: number
  deliveries: { pending: number; succeeded: number; failed: number }
  failedActions: number
  agentRuns: number
  agentCostUsd: string
}
