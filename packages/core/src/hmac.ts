import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export function hmacSha256Hex(secret: string | Uint8Array, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex')
}

export function sha256Hex(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function withinWindow(timestampSeconds: number, nowSeconds: number, windowSeconds: number): boolean {
  return Number.isFinite(timestampSeconds) && Math.abs(nowSeconds - timestampSeconds) <= windowSeconds
}
