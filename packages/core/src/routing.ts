import type { Envelope } from './envelope'

export const MAX_REGEX_LENGTH = 200

export interface RouteMatchFields {
  enabled: boolean
  connectionId: string | null
  eventType: string
  textContains: string | null
  textRegex: string | null
  includeSubtypes: boolean
}

export type MatchableEnvelope = Pick<Envelope, 'connectionId' | 'type' | 'subtype' | 'text'>

export function validateRegex(source: string): string | null {
  if (source.length > MAX_REGEX_LENGTH) return `regex must be at most ${MAX_REGEX_LENGTH} characters`
  try {
    new RegExp(source)
    return null
  } catch (err) {
    return `regex does not compile: ${err instanceof Error ? err.message : String(err)}`
  }
}

function typeMatches(pattern: string, type: string): boolean {
  return pattern.endsWith('*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern
}

export function matchRoute(route: RouteMatchFields, envelope: MatchableEnvelope): boolean {
  if (!route.enabled) return false
  if (route.connectionId !== null && route.connectionId !== envelope.connectionId) return false
  if (!typeMatches(route.eventType, envelope.type)) return false
  if (!route.includeSubtypes && envelope.subtype !== null) return false
  if (route.textContains !== null) {
    if (envelope.text === null || !envelope.text.toLowerCase().includes(route.textContains.toLowerCase())) return false
  }
  if (route.textRegex !== null) {
    if (envelope.text === null || validateRegex(route.textRegex) !== null) return false
    if (!new RegExp(route.textRegex).test(envelope.text)) return false
  }
  return true
}
