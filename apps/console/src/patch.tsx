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

const CODES: Record<string, string> = { slack: 'slk', webhook: 'whk', http: 'http', agent: 'agt', any: 'any' }

export const jackCode = (kind: string) => CODES[kind] ?? kind.slice(0, 3)

export const lineLabel = (c: Connection | undefined, fallbackId?: string, provider?: string) => {
  if (!c) return fallbackId ? `${provider ?? 'line'} ${fallbackId.slice(0, 8)}` : 'Any connection'
  if (c.provider === 'slack') return `slack ${c.userId ?? c.teamId ?? c.id.slice(0, 8)}`
  return `${c.provider} ${c.id.slice(0, 8)}`
}

function Jack({ code, children, side, muted }: { code: string; children: ReactNode; side: 'out' | 'in'; muted?: boolean }) {
  return (
    <span
      className={cx(
        'relative flex h-cell min-w-0 items-center gap-2 border bg-raised pr-2 pl-1 text-sm',
        muted ? 'border-rule text-ink-2' : 'border-edge',
      )}
    >
      <span className="grid h-6 min-w-9 shrink-0 place-items-center border border-rule bg-ground px-1 font-mono text-[0.6875rem] leading-none tracking-wide text-ink-2 uppercase">
        {jackCode(code)}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span
        aria-hidden="true"
        className={cx(
          'absolute top-1/2 size-2 -translate-y-1/2 border',
          side === 'out' ? 'hidden sm:block sm:-right-1' : '-left-1',
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
  const step = 40
  const h = n * step - 8
  const cords = targets.map((_, i) => {
    const y = i * step + 16
    return `M0 16 C 40 16, 40 ${y}, 80 ${y}`
  })
  return (
    <div className="grid min-w-0 grid-cols-1 sm:grid-cols-[minmax(0,15rem)_5rem_minmax(0,1fr)]">
      <div className="min-w-0">
        <span className="sr-only">Line: </span>
        <Jack code={sourceCode} side="out" muted={!live}>
          {sourceLabel}
        </Jack>
      </div>
      <svg viewBox={`0 0 80 ${h}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" className="hidden h-full w-full overflow-visible sm:block">
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
        className="mt-2 ml-4 flex min-w-0 flex-col gap-2 border-l border-edge pl-4 sm:mt-0 sm:ml-0 sm:border-l-0 sm:pl-0"
      >
        {targets.length === 0 ? <li className="flex h-cell items-center text-sm text-ink-3">No destinations</li> : null}
        {targets.map((t) => (
          <li key={t.key} className="relative min-w-0 before:absolute before:top-1/2 before:-left-4 before:h-px before:w-4 before:bg-edge sm:before:hidden">
            <Jack code={t.code} side="in" muted={!live}>
              <span className="inline-flex min-w-0 max-w-full items-center gap-2">
                {t.lamp ? (
                  <span title={t.lamp.text} className="inline-flex">
                    <Lamp key={t.lamp.state} state={t.lamp.state} />
                  </span>
                ) : null}
                <span className="truncate">{t.label}</span>
                {t.note ? <span className="truncate text-xs text-ink-3">{t.note}</span> : null}
                {t.lamp ? <span className="sr-only">, {t.lamp.text}</span> : null}
              </span>
            </Jack>
          </li>
        ))}
      </ul>
    </div>
  )
}
