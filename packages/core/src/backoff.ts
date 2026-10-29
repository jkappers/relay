export interface BackoffOptions {
  baseMs: number
  capMs: number
  factor?: number
  random?: () => number
}

export function computeBackoffMs(attempt: number, opts: BackoffOptions): number {
  const ceiling = Math.min(opts.capMs, opts.baseMs * (opts.factor ?? 2) ** Math.max(0, attempt - 1))
  return Math.floor((opts.random ?? Math.random)() * ceiling)
}

export function parseRetryAfterMs(header: string | null): number | null {
  if (header === null || !/^\s*\d+\s*$/.test(header)) return null
  return Number(header.trim()) * 1000
}
