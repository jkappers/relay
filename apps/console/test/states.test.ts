import { describe, expect, it } from 'vitest'
import { DETAIL_STATE, noDeliveriesText, ROUTED_SHORT, ROUTED_TEXT, STATE_TEXT, type DetailState, type RoutedState } from '../src/states'

const DETAIL: DetailState[] = ['pending', 'routed', 'classified_none', 'unmatched', 'skipped_echo', 'skipped_inactive']

describe('routed states', () => {
  it('shows classified_none as its own state, not as unmatched', () => {
    expect(DETAIL_STATE.classified_none).toBe('classified_none')
    expect(ROUTED_TEXT.classified_none[1]).toMatch(/classifier picked none/)
    expect(ROUTED_SHORT.classified_none).toBe('not picked')
    expect(STATE_TEXT.classified_none).not.toBe(STATE_TEXT.unmatched)
    expect(noDeliveriesText('classified_none')).toMatch(/classifier/)
    expect(noDeliveriesText('unmatched')).toBe('No enabled route matched this event.')
  })

  it('has text for every state', () => {
    for (const s of DETAIL) {
      const routed: RoutedState = DETAIL_STATE[s]
      expect(ROUTED_TEXT[routed][1]).toBeTruthy()
      expect(ROUTED_SHORT[routed]).toBeTruthy()
      expect(STATE_TEXT[s]).toBeTruthy()
      expect(noDeliveriesText(s)).toBeTruthy()
    }
  })
})
