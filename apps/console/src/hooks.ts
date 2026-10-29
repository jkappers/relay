import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'

export function useHashPath(): string {
  const read = () => window.location.hash.replace(/^#/, '') || '/'
  const [path, setPath] = useState(read)
  useEffect(() => {
    const on = () => setPath(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return path
}

export const navigate = (path: string) => {
  window.location.hash = path
}

export interface Loaded<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    let live = true
    setLoading(true)
    loadRef
      .current()
      .then((d) => {
        if (!live) return
        setData(d)
        setError(null)
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof ApiError ? e.describe() : String(e))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [...deps, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload }
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export const errorText = (e: unknown) => (e instanceof ApiError ? e.describe() : e instanceof Error ? e.message : String(e))

export function parseRoute(path: string): { base: string; event: string | null } {
  const [base = '/', qs = ''] = path.split('?')
  const m = /^\/events\/([0-9a-f-]{36})$/.exec(base)
  if (m) return { base: '/events', event: m[1]! }
  return { base, event: /(?:^|&)event=([0-9a-f-]{36})(?:&|$)/.exec(qs)?.[1] ?? null }
}

export const eventHref = (base: string, id: string) => (base === '/events' ? `#/events/${id}` : `#${base}?event=${id}`)

export const focusRow = (id: string) => document.querySelector<HTMLElement>(`[data-ev="${id}"]`)?.focus()

export function useListNav(ids: string[], base: string, open: string | null) {
  const [sel, setSel] = useState(-1)
  const ref = useRef({ ids, open, sel })
  ref.current = { ids, open, sel }
  const openIdx = open ? ids.indexOf(open) : -1
  useEffect(() => {
    if (openIdx >= 0) setSel(openIdx)
  }, [openIdx])
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || t.closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === '/') {
        const f = document.getElementById('filter')
        if (!f) return
        e.preventDefault()
        f.focus()
        return
      }
      const inList = t.closest('[data-list]') !== null
      const d = e.key === 'j' || (inList && e.key === 'ArrowDown') ? 1 : e.key === 'k' || (inList && e.key === 'ArrowUp') ? -1 : 0
      const { ids, open, sel } = ref.current
      if (!d || ids.length === 0) return
      e.preventDefault()
      const n = Math.max(0, Math.min(ids.length - 1, sel + d))
      const id = ids[n]!
      setSel(n)
      if (open) window.location.replace(eventHref(base, id))
      else focusRow(id)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [base])
  return [sel, setSel] as const
}
