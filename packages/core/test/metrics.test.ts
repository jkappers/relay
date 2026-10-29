import { describe, expect, it } from 'vitest'
import { MetricsRegistry } from '../src'

describe('metrics registry', () => {
  it('renders Prometheus text', () => {
    const r = new MetricsRegistry()
    const c = r.counter('relay_test_total', 'A test counter.', ['provider', 'outcome'] as const)
    c.inc({ provider: 'slack', outcome: 'accepted' })
    c.inc({ provider: 'slack', outcome: 'accepted' })
    c.inc({ provider: 'we"ird', outcome: 'x' })
    expect(r.render()).toBe(
      [
        '# HELP relay_test_total A test counter.',
        '# TYPE relay_test_total counter',
        'relay_test_total{provider="slack",outcome="accepted"} 2',
        'relay_test_total{provider="we\\"ird",outcome="x"} 1',
        '',
      ].join('\n'),
    )
  })

  it('renders a gauge', () => {
    const r = new MetricsRegistry()
    const g = r.gauge('relay_test_up', 'A test gauge.')
    expect(r.gauge('relay_test_up', 'again')).toBe(g)
    g.set(1)
    expect(r.render()).toBe(['# HELP relay_test_up A test gauge.', '# TYPE relay_test_up gauge', 'relay_test_up 1', ''].join('\n'))
    expect(() => r.counter('relay_test_up', 'x')).toThrow()
  })
})
