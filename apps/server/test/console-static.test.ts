import { describe, expect, it } from 'vitest'
import { INDEX_HTML, signIn, useHarness } from './harness'

const h = useHarness()

describe('console static serving', () => {
  it('serves index.html at /', async () => {
    const res = await h.app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toBe(INDEX_HTML)
  })

  it('serves built assets', async () => {
    const res = await h.app.request('/assets/app.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toBe('console.log(1)')
  })

  it('falls back to index.html for unknown SPA paths', async () => {
    for (const path of ['/connections', '/events/123']) {
      const res = await h.app.request(path)
      expect(res.status, path).toBe(200)
      expect(await res.text()).toBe(INDEX_HTML)
    }
  })

  it('returns JSON 404s for /api, not the SPA', async () => {
    const { cookie } = await signIn(h)
    const res = await h.app.request('/api/unknown', { headers: { cookie } })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('does not serve the SPA for server paths', async () => {
    for (const path of ['/hooks/nothing', '/oauth/nothing', '/actions/nothing', '/metrics/x', '/healthz/x']) {
      const res = await h.app.request(path)
      expect(res.status, path).toBe(404)
      expect(await res.text()).not.toContain('<div id="root">')
    }
  })

  it('does not traverse out of the dist dir', async () => {
    const res = await h.app.request('/..%2f..%2fpackage.json')
    expect(await res.text()).toBe(INDEX_HTML)
  })

  it('sets a strict CSP and friends', async () => {
    for (const path of ['/', '/connections', '/assets/app.js']) {
      const res = await h.app.request(path)
      const csp = res.headers.get('content-security-policy')!
      expect(csp, path).toContain("default-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).not.toContain('unsafe-inline')
      expect(csp).not.toContain('unsafe-eval')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    }
    const api = await h.app.request('/api/session')
    expect(api.headers.get('content-security-policy')).toContain("default-src 'self'")
  })
})
