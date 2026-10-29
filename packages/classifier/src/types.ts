export interface ClassifierCandidate {
  label: string
  intent: string
}

export interface ClassifyInput {
  eventType: string
  text: string | null
  candidates: ClassifierCandidate[]
}

export type ClassifyOutcome = 'ok' | 'timeout' | 'error' | 'refusal' | 'invalid'

export interface ClassifyResult {
  outcome: ClassifyOutcome
  /** Lowercased and deduped. Empty unless `outcome` is `ok`. Not yet checked against the candidates. */
  labels: string[]
  error?: string
  model: string
  usage: { inputTokens: number; outputTokens: number }
}

export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassifyResult>
}

export const CLASSIFIER_MODEL = 'claude-haiku-5-5'
