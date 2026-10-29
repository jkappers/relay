import { hmacSha256Hex, safeEqual, SignatureError, withinWindow } from '@relay/core'

export const SLACK_TIMESTAMP_WINDOW_SECONDS = 300

export function computeSlackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  return `v0=${hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`)}`
}

export function verifySlackSignature(input: {
  signingSecret: string
  timestamp: string | null
  signature: string | null
  rawBody: string
  nowSeconds: number
}): void {
  const { signingSecret, timestamp, signature, rawBody, nowSeconds } = input
  if (!timestamp || !signature) throw new SignatureError('missing signature headers')
  if (!/^\d+$/.test(timestamp)) throw new SignatureError('malformed timestamp')
  if (!withinWindow(Number(timestamp), nowSeconds, SLACK_TIMESTAMP_WINDOW_SECONDS)) {
    throw new SignatureError('timestamp outside window')
  }
  const expected = computeSlackSignature(signingSecret, timestamp, rawBody)
  if (!safeEqual(expected, signature)) throw new SignatureError('signature mismatch')
}
