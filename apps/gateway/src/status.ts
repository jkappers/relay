import { schema, type Db } from '@relay/core'
import type { GatewayStatusWriter } from './controller'

/** Upserts the Discord row of provider_app_status, which the admin console reads. */
export function createStatusWriter(db: Db): GatewayStatusWriter {
  const { providerAppStatus } = schema
  return {
    async write(patch) {
      const now = new Date()
      const set = {
        state: patch.state,
        updatedAt: now,
        ...(patch.lastReadyAt ? { lastReadyAt: patch.lastReadyAt } : {}),
        ...(patch.lastCloseCode !== undefined ? { lastCloseCode: patch.lastCloseCode } : {}),
      }
      await db
        .insert(providerAppStatus)
        .values({ provider: 'discord', ...set })
        .onConflictDoUpdate({ target: providerAppStatus.provider, set })
    },
  }
}
