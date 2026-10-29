export type LampState = 'ok' | 'warn' | 'bad' | 'off'

export type RoutedState = 'pending' | 'inactive' | 'echo' | 'routed' | 'classified_none' | 'unmatched'

export type DetailState = 'pending' | 'skipped_inactive' | 'skipped_echo' | 'routed' | 'classified_none' | 'unmatched'

export const ROUTED_TEXT: Record<RoutedState, [LampState, string]> = {
  pending: ['warn', 'Waiting to be routed'],
  routed: ['ok', 'Routed to destinations'],
  echo: ['ok', 'Skipped: echo of a Relay message'],
  classified_none: ['off', 'Not routed: the classifier picked none of the matched routes'],
  unmatched: ['off', 'Not routed: no route matched'],
  inactive: ['off', 'Not routed: connection not active'],
}

export const ROUTED_SHORT: Record<RoutedState, string> = {
  pending: 'routing',
  routed: 'routed',
  echo: 'echo skipped',
  classified_none: 'not picked',
  unmatched: 'no route',
  inactive: 'line inactive',
}

export const DETAIL_STATE: Record<DetailState, RoutedState> = {
  pending: 'pending',
  routed: 'routed',
  classified_none: 'classified_none',
  unmatched: 'unmatched',
  skipped_echo: 'echo',
  skipped_inactive: 'inactive',
}

export const STATE_TEXT: Record<DetailState, string> = {
  pending: 'Not routed yet',
  routed: 'Routed',
  classified_none: 'Routed, classifier picked no route',
  unmatched: 'Routed, no route matched',
  skipped_echo: 'Skipped: echo of a Relay message',
  skipped_inactive: 'Skipped: connection not active',
}

export function noDeliveriesText(state: DetailState): string {
  if (state === 'unmatched') return 'No enabled route matched this event.'
  if (state === 'classified_none') return 'Gated routes matched, but the classifier (or its fallback) picked none of them. See the decision below.'
  return `${STATE_TEXT[state]}.`
}
