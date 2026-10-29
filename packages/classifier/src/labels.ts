export interface LabeledCandidate {
  routeId: string
  label: string
}

/** Opaque labels r1..rn, in the order given. */
export function assignLabels(routeIds: string[]): LabeledCandidate[] {
  return routeIds.map((routeId, i) => ({ routeId, label: `r${i + 1}` }))
}

/** Maps model labels to route ids. Anything outside the candidate set is dropped. */
export function mapLabels(labels: readonly unknown[], candidates: readonly LabeledCandidate[]): string[] {
  const byLabel = new Map(candidates.map((c) => [c.label.toLowerCase(), c.routeId]))
  const out = new Set<string>()
  for (const l of labels) {
    if (typeof l !== 'string') continue
    const id = byLabel.get(l.trim().toLowerCase())
    if (id) out.add(id)
  }
  return [...out]
}
