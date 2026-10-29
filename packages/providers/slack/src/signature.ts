import { hmacSha256Hex, safeEqual, SignatureError, withinWindow } from '@relay/core'

export const SLACK_TIMESTAMP_WINDOW_SECONDS = 300

export function computeSlackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  return `v0=${hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`)}`
}

/** Checks the request against every secret and returns the index of the first that signed it. Throws SignatureError otherwise. */
export function verifySlackSignature(input: {
  signingSecrets: readonly string[]
  timestamp: string | null
  signature: string | null
  rawBody: string
  nowSeconds: number
}): number {
  const { signingSecrets, timestamp, signature, rawBody, nowSeconds } = input
  if (!timestamp || !signature) throw new SignatureError('missing signature headers')
  if (!/^\d+$/.test(timestamp)) throw new SignatureError('malformed timestamp')
  if (!withinWindow(Number(timestamp), nowSeconds, SLACK_TIMESTAMP_WINDOW_SECONDS)) {
    throw new SignatureError('timestamp outside window')
  }
  let matched = -1
  for (const [i, secret] of signingSecrets.entries()) {
    const ok = secret.length > 0 && safeEqual(computeSlackSignature(secret, timestamp, rawBody), signature)
    if (ok && matched === -1) matched = i
  }
  if (matched === -1) throw new SignatureError('signature mismatch')
  return matched
}
