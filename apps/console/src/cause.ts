const MAX = 28

export function condenseCause(error: string | null | undefined): string {
  const text = error?.trim()
  if (!text) return 'failed'
  const sys = /\b(E[A-Z]{3,}[A-Z_]*)\b(?:\s+(\S+))?/.exec(text)
  if (sys?.[1]) {
    const target = sys[2]?.replace(/[,;:]+$/, '') ?? ''
    const port = /:(\d{1,5})$/.exec(target)?.[1]
    return port ? `${sys[1]} :${port}` : target && !/\s/.test(target) && target.length <= 24 ? `${sys[1]} ${target}` : sys[1]
  }
  const http = /\b(?:HTTP|status(?: code)?)[\s:]+(\d{3})\b/i.exec(text) ?? /^(\d{3})\b/.exec(text)
  if (http?.[1]) return `HTTP ${http[1]}`
  const timeout = /\b(?:timed? ?out|timeout)\b(?:\D+(\d+)\s*ms)?/i.exec(text)
  if (timeout) {
    const ms = Number(timeout[1])
    return ms ? `timeout ${ms / 1000}s` : 'timeout'
  }
  const line = text.split('\n')[0]!.replace(/_/g, ' ')
  return line.length > MAX ? `${line.slice(0, MAX - 1).trimEnd()}…` : line
}
