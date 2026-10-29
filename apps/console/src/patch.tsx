import type { ReactNode } from 'react'
import type { Connection } from './api'
import { cx } from './components'
import { Lamp, type LampState } from './trace'

export interface PatchTarget {
  key: string
  code: string
  label: string
  note?: string
  lamp?: { state: LampState; text: string }
}

const CODES: Record<string, string> = { slack: 'slk', webhook: 'whk', sms: 'sms', http: 'http', agent: 'agt', any: 'any' }

export const jackCode = (kind: string) => CODES[kind] ?? kind.slice(0, 3)

export const lineLabel = (c: Connection | undefined, fallbackId?: string, provider?: string) => {
  if (!c) return fallbackId ? `${provider ?? 'line'} ${fallbackId.slice(0, 8)}` : 'Any connection'
  if (c.name) return c.name
  if (c.provider === 'slack') return `slack ${c.userId ?? c.teamId ?? c.id.slice(0, 8)}`
  return `${c.provider} ${c.id.slice(0, 8)}`
}

function Jack({ code, children, side, muted }: { code: string; children: ReactNode; side: 'out' | 'in'; muted?: boolean }) {
  return (
    <span
      className={cx(
        'relative flex h-6 min-w-0 items-center gap-1.5 rounded-jack border bg-raised pr-2 pl-0.5 text-xs',
        muted ? 'border-rule text-ink-2' : 'border-line',
      )}
    >
      <span className="jack-code h-4.5 min-w-7 shrink-0 bg-ground">
        {jackCode(code)}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span
        aria-hidden="true"
        className={cx(
          'absolute top-1/2 size-1.5 -translate-y-1/2 border',
          side === 'out' ? 'hidden @md:block -right-[3.5px]' : '-left-[3.5px]',
          muted ? 'border-edge bg-ground' : 'border-accent bg-accent',
        )}
      />
    </span>
  )
}

export function Patch({
  sourceCode,
  sourceLabel,
  targets,
  live,
  label,
}: {
  sourceCode: string
  sourceLabel: string
  targets: PatchTarget[]
  live: boolean
  label: string
}) {
  const n = Math.max(targets.length, 1)
  const step = 28
  const h = n * step - 4
  const cords = targets.map((_, i) => {
    const y = i * step + 12
    return `M0 12 C 32 12, 32 ${y}, 64 ${y}`
  })
  return (
    <div className="@container min-w-0"><div className="grid min-w-0 grid-cols-1 @md:grid-cols-[minmax(0,11rem)_3rem_minmax(0,1fr)]">
      <div className="min-w-0">
        <span className="sr-only">Line: </span>
        <Jack code={sourceCode} side="out" muted={!live}>
          {sourceLabel}
        </Jack>
      </div>
      <svg viewBox={`0 0 64 ${h}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" className="hidden h-full w-full overflow-visible @md:block">
        {cords.map((d, i) => (
          <path
            key={targets[i]!.key}
            d={d}
            fill="none"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            strokeDasharray={live ? undefined : '4 3'}
            className={live ? 'stroke-accent' : 'stroke-edge'}
          />
        ))}
      </svg>
      <ul
        aria-label={label}
        className="mt-1 ml-3 flex min-w-0 flex-col gap-1 border-l border-line pl-3 @md:mt-0 @md:ml-0 @md:border-l-0 @md:pl-0"
      >
        {targets.length === 0 ? <li className="flex h-6 items-center text-xs text-ink-3">No destinations</li> : null}
        {targets.map((t) => (
          <li key={t.key} className="relative min-w-0 before:absolute before:top-1/2 before:-left-3 before:h-px before:w-3 before:bg-line @md:before:hidden">
            <Jack code={t.code} side="in" muted={!live}>
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                {t.lamp ? (
                  <span title={t.lamp.text} className="inline-flex">
                    <Lamp key={t.lamp.state} state={t.lamp.state} className="size-2.5" />
                  </span>
                ) : null}
                <span className="shrink-0">{t.label}</span>
                {t.note ? <span className="min-w-0 shrink-[9] truncate text-ink-3">{t.note}</span> : null}
                {t.lamp ? <span className="sr-only">, {t.lamp.text}</span> : null}
              </span>
            </Jack>
          </li>
        ))}
      </ul>
    </div></div>
  )
}

export const lineId = (c: Connection | undefined, fallbackId: string) =>
  c?.provider === 'slack' ? (c.userId ?? c.teamId ?? c.id.slice(0, 8)) : (c?.id ?? fallbackId).slice(0, 8)
