import type { Classifier, ClassifyInput, ClassifyResult } from './types'

export type FakeClassifierScript = (input: ClassifyInput) => Promise<Partial<ClassifyResult> | void> | Partial<ClassifyResult> | void

export const FAKE_CLASSIFIER_MODEL = 'fake'

/** A classifier with no network. Tests script it; `RELAY_CLASSIFIER=fake` uses the demo script. */
export function createFakeClassifier(script: FakeClassifierScript): Classifier {
  return {
    async classify(input) {
      const out = (await script(input)) ?? {}
      return { outcome: 'ok', labels: [], model: FAKE_CLASSIFIER_MODEL, usage: { inputTokens: 10, outputTokens: 2 }, ...out }
    },
  }
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])

/** Picks each route whose intent shares a word of 4+ letters with the event text. */
export function createDemoClassifier(): Classifier {
  return createFakeClassifier((input) => {
    const text = words(input.text ?? '')
    const labels = input.candidates.filter((c) => [...words(c.intent)].some((w) => text.has(w))).map((c) => c.label)
    return { labels }
  })
}
