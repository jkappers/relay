import { createHmac, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from './db/client'
import { connections, deliveries, events as schemaEvents, revokedTokens, type DeliveryRow } from './db/schema'
import { safeEqual } from './hmac'

export const DEFAULT_REPLY_TOKEN_TTL_SECONDS = 3600

export function deriveReplyTokenKey(masterKey: Uint8Array): Buffer {
  return createHmac('sha256', masterKey).update('relay/reply-token/v1').digest()
}

const payloadSchema = z.object({
  jti: z.string().min(1),
  did: z.uuid(),
  exp: z.number().int(),
  allowed: z.array(z.string()),
})
export type ReplyTokenPayload = z.infer<typeof payloadSchema>

const sign = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest('base64url')

export function mintReplyToken(
  key: Buffer,
  input: { deliveryId: string; allowed: string[]; ttlSeconds: number; nowSeconds: number; jti?: string },
): { token: string; jti: string; exp: number } {
  const jti = input.jti ?? randomUUID()
  const exp = input.nowSeconds + input.ttlSeconds
  const payload: ReplyTokenPayload = { jti, did: input.deliveryId, exp, allowed: input.allowed }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return { token: `${body}.${sign(key, body)}`, jti, exp }
}

export type TokenRejection =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'revoked'
  | 'unknown_delivery'
  | 'connection_inactive'

export type TokenCheck = { ok: true; payload: ReplyTokenPayload } | { ok: false; reason: TokenRejection }

export function verifyTokenSignature(key: Buffer, token: string, nowSeconds: number): TokenCheck {
  const parts = token.split('.')
  if (parts.length !== 2) return { ok: false, reason: 'malformed' }
  const [body, mac] = parts as [string, string]
  if (!safeEqual(sign(key, body), mac)) return { ok: false, reason: 'bad_signature' }
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const parsed = payloadSchema.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'malformed' }
  if (parsed.data.exp < nowSeconds) return { ok: false, reason: 'expired' }
  return { ok: true, payload: parsed.data }
}

export type FullTokenCheck =
  | { ok: true; payload: ReplyTokenPayload; delivery: DeliveryRow }
  | { ok: false; reason: TokenRejection }

export async function verifyReplyToken(db: Db, key: Buffer, token: string, nowSeconds: number): Promise<FullTokenCheck> {
  const sig = verifyTokenSignature(key, token, nowSeconds)
  if (!sig.ok) return sig
  const { payload } = sig

  const [revoked] = await db.select({ jti: revokedTokens.jti }).from(revokedTokens).where(eq(revokedTokens.jti, payload.jti))
  if (revoked) return { ok: false, reason: 'revoked' }

  const [row] = await db
    .select({ delivery: deliveries, status: connections.status })
    .from(deliveries)
    .innerJoin(schemaEvents, eq(schemaEvents.id, deliveries.eventId))
    .innerJoin(connections, eq(connections.id, schemaEvents.connectionId))
    .where(eq(deliveries.id, payload.did))
  if (!row) return { ok: false, reason: 'unknown_delivery' }
  if (row.status !== 'active') return { ok: false, reason: 'connection_inactive' }
  return { ok: true, payload, delivery: row.delivery }
}

export async function revokeReplyToken(db: Db, jti: string): Promise<void> {
  await db.insert(revokedTokens).values({ jti }).onConflictDoNothing()
}
