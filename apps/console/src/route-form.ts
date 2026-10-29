export const MAX_INTENT = 500
export const MAX_ACTORS = 100
export const MAX_ACTOR_ID = 200

export type Selection = 'always' | 'classifier'
export type Fallback = 'drop' | 'deliver'

export interface RouteForm {
  name: string
  eventType: string
  textContains: string
  textRegex: string
  includeSubtypes: boolean
  enabled: boolean
  destinationIds: string[]
  selection: Selection
  intent: string
  classifierFallback: Fallback
  actorIn: string
}

export const parseActors = (s: string): string[] => [...new Set(s.split(/[\s,]+/).filter(Boolean))]

export function routeFormProblems(f: Pick<RouteForm, 'selection' | 'intent' | 'actorIn'>): string[] {
  const out: string[] = []
  const intent = f.intent.trim()
  if (f.selection === 'classifier' && !intent) out.push('A classifier route needs an intent.')
  if (intent.length > MAX_INTENT) out.push(`Intent must be at most ${MAX_INTENT} characters.`)
  const actors = parseActors(f.actorIn)
  if (actors.length > MAX_ACTORS) out.push(`At most ${MAX_ACTORS} actor IDs.`)
  if (actors.some((a) => a.length > MAX_ACTOR_ID)) out.push(`Each actor ID must be at most ${MAX_ACTOR_ID} characters.`)
  return out
}

export const matchFields = (f: RouteForm) => {
  const actors = parseActors(f.actorIn)
  return {
    eventType: f.eventType,
    textContains: f.textContains || null,
    textRegex: f.textRegex || null,
    includeSubtypes: f.includeSubtypes,
    actorIn: actors.length ? actors : null,
    enabled: true,
  }
}

export const routeBody = (f: RouteForm) => ({
  ...matchFields(f),
  enabled: f.enabled,
  name: f.name,
  destinationIds: f.destinationIds,
  selection: f.selection,
  intent: f.intent.trim() || null,
  classifierFallback: f.classifierFallback,
})
