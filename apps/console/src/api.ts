export interface Issue {
  path: string
  message: string
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: Issue[] = [],
  ) {
    super(message)
  }

  describe(): string {
    if (this.issues.length === 0) return this.message
    return this.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')
  }
}

export const UNAUTHORIZED_EVENT = 'relay:unauthorized'

export async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Relay-Console': '1' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, {
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
    throw new ApiError(d.message ?? d.error ?? `request failed (${res.status})`, res.status, d.issues ?? [])
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
  provider: string
  teamId: string | null
  userId: string | null
  status: 'active' | 'revoked'
  createdAt: string
}

export interface WebhookCreated extends Connection {
  url: string
  secret: string
}

export interface AgentConfig {
  systemPrompt: string
  model: string
  maxTurns: number
  timeoutSeconds: number
  maxMutatingActions: number
}

export interface Destination {
  id: string
  name: string
  kind: 'http' | 'agent'
  url: string | null
  enabled: boolean
  maxAttempts: number
  timeoutMs: number
  allowedActions: string[] | null
  config: AgentConfig | null
  routeCount?: number
  createdAt: string
}

export interface Route {
  id: string
  name: string
  connectionId: string | null
  eventType: string
  textContains: string | null
  textRegex: string | null
  includeSubtypes: boolean
  enabled: boolean
  destinationIds: string[]
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
  eventType?: string
}

export interface EventDetail {
  id: string
  provider: string
  connectionId: string
  receivedAt: string
  routedAt: string | null
  state: 'pending' | 'skipped_inactive' | 'skipped_echo' | 'routed' | 'unmatched'
  echo: boolean
  routed: boolean
  envelope: unknown
  raw: unknown
  deliveries: DeliveryRow[]
  actions: Record<string, unknown>[]
  agentRuns: Record<string, unknown>[]
}

export interface Overview {
  windowHours: number
  events: number
  deliveries: { pending: number; succeeded: number; failed: number }
  failedActions: number
  agentRuns: number
  agentCostUsd: string
}
