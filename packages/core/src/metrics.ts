type Labels<L extends string> = Record<L, string>

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

export class Counter<L extends string = never> {
  private readonly values = new Map<string, { labels: Labels<L>; value: number }>()

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly L[],
  ) {}

  inc(labels: Labels<L>, by = 1): void {
    const key = this.labelNames.map((n) => labels[n]).join('\u0000')
    const entry = this.values.get(key)
    if (entry) entry.value += by
    else this.values.set(key, { labels: { ...labels }, value: by })
  }

  get(labels: Labels<L>): number {
    return this.values.get(this.labelNames.map((n) => labels[n]).join('\u0000'))?.value ?? 0
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    if (this.values.size === 0 && this.labelNames.length === 0) lines.push(`${this.name} 0`)
    for (const { labels, value } of this.values.values()) {
      const parts = this.labelNames.map((n) => `${n}="${escapeLabel(labels[n])}"`)
      lines.push(parts.length ? `${this.name}{${parts.join(',')}} ${value}` : `${this.name} ${value}`)
    }
    return lines.join('\n')
  }
}

/** A value that goes up and down. No labels; a gateway connection is one thing. */
export class Gauge {
  private value = 0

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(value: number): void {
    this.value = value
  }

  get(): number {
    return this.value
  }

  render(): string {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name} ${this.value}`].join('\n')
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter<string> | Gauge>()

  counter<L extends string = never>(name: string, help: string, labelNames: readonly L[] = []): Counter<L> {
    const existing = this.counters.get(name)
    if (existing instanceof Gauge) throw new Error(`${name} is a gauge`)
    if (existing) return existing as unknown as Counter<L>
    const counter = new Counter<L>(name, help, labelNames)
    this.counters.set(name, counter as unknown as Counter<string>)
    return counter
  }

  gauge(name: string, help: string): Gauge {
    const existing = this.counters.get(name)
    if (existing && !(existing instanceof Gauge)) throw new Error(`${name} is a counter`)
    if (existing) return existing
    const gauge = new Gauge(name, help)
    this.counters.set(name, gauge)
    return gauge
  }

  render(): string {
    return [...this.counters.values()].map((c) => c.render()).join('\n') + '\n'
  }
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'
