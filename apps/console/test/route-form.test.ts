import { describe, expect, it } from 'vitest'
import { createRouteInput, MAX_ACTOR_ID_LENGTH, MAX_ACTOR_IN, MAX_INTENT_LENGTH } from '@relay/core'
import { MAX_ACTOR_ID, MAX_ACTORS, MAX_INTENT, parseActors, routeBody, routeFormProblems, type RouteForm } from '../src/route-form'

const form = (o: Partial<RouteForm> = {}): RouteForm => ({
  name: 'r',
  eventType: 'slack.message.*',
  textContains: '',
  textRegex: '',
  includeSubtypes: false,
  enabled: true,
  destinationIds: ['00000000-0000-4000-8000-000000000001'],
  selection: 'always',
  intent: '',
  classifierFallback: 'drop',
  actorIn: '',
  ...o,
})

const serverAccepts = (f: RouteForm) => createRouteInput.safeParse(routeBody(f)).success

describe('route form', () => {
  it('uses the server limits', () => {
    expect([MAX_INTENT, MAX_ACTORS, MAX_ACTOR_ID]).toEqual([MAX_INTENT_LENGTH, MAX_ACTOR_IN, MAX_ACTOR_ID_LENGTH])
  })

  it('splits actor IDs on commas and whitespace, dropping blanks and repeats', () => {
    expect(parseActors(' U1, U2\nU3  U1,,')).toEqual(['U1', 'U2', 'U3'])
    expect(parseActors('  ')).toEqual([])
    expect(routeBody(form({ actorIn: '' })).actorIn).toBeNull()
    expect(routeBody(form({ actorIn: 'U1,U2' })).actorIn).toEqual(['U1', 'U2'])
  })

  it('sends every classifier field so the server never falls back to stored values', () => {
    const body = routeBody(form({ selection: 'classifier', intent: '  invoices ', classifierFallback: 'deliver' }))
    expect(body).toMatchObject({ selection: 'classifier', intent: 'invoices', classifierFallback: 'deliver' })
    expect(routeBody(form()).intent).toBeNull()
  })

  it.each<[string, Partial<RouteForm>]>([
    ['always, no intent', {}],
    ['classifier with intent', { selection: 'classifier', intent: 'billing' }],
    ['classifier, no intent', { selection: 'classifier', intent: '   ' }],
    ['intent at the limit', { selection: 'classifier', intent: 'a'.repeat(500) }],
    ['intent over the limit', { selection: 'classifier', intent: 'a'.repeat(501) }],
    ['actors at the limit', { actorIn: Array.from({ length: 100 }, (_, i) => `U${i}`).join(',') }],
    ['too many actors', { actorIn: Array.from({ length: 101 }, (_, i) => `U${i}`).join(',') }],
    ['actor ID at the limit', { actorIn: 'x'.repeat(200) }],
    ['actor ID too long', { actorIn: 'x'.repeat(201) }],
  ])('agrees with the server: %s', (_, o) => {
    const f = form(o)
    expect(routeFormProblems(f).length === 0).toBe(serverAccepts(f))
  })
})
