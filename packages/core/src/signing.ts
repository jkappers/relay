import { hmacSha256Hex } from './hmac'

export const RELAY_VERSION = '0.2.0'

export function computeSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`
}
