import { createHmac } from 'node:crypto'
import { safeEqual } from '@relay/core'

export type TwilioParams = Record<string, string | readonly string[]>

/** Repeated form keys, grouped by name. */
export function paramsFromForm(rawBody: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of new URLSearchParams(rawBody)) (out[k] ??= []).push(v)
  return out
}

/**
 * Twilio: base64(HMAC-SHA1(authToken, url + name+value for each param, names sorted)).
 * A repeated name contributes its distinct values, sorted. Matches twilio-node's getExpectedTwilioSignature.
 */
export function computeTwilioSignature(authToken: string, url: string, params: TwilioParams): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => {
      const v = params[key]!
      const values = typeof v === 'string' ? [v] : [...new Set(v)].sort()
      return acc + values.map((x) => key + x).join('')
    }, url)
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
}

/** Twilio signs the URL as configured, and the port may or may not be spelled out, so try both. */
function urlVariants(url: string): string[] {
  const u = new URL(url)
  const bare = new URL(url)
  bare.port = ''
  // URL drops default ports, so build the explicit form by hand.
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  const explicit = `${u.protocol}//${u.hostname}:${port}${u.pathname}${u.search}`
  return [...new Set([url, bare.toString(), explicit])]
}

export function verifyTwilioSignature(authToken: string, url: string, params: TwilioParams, header: string): boolean {
  return urlVariants(url).some((candidate) => safeEqual(computeTwilioSignature(authToken, candidate, params), header))
}
