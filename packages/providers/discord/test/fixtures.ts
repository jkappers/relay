import { readFileSync } from 'node:fs'
import type { GatewayDispatch } from '@relay/core'

export const BOT_ID = '1100000000000000001'
export const GUILD_ID = '2909267986347357250'
export const INSTALLER_ID = '53908099506183680'

export function fixture(name: string): GatewayDispatch & { d: Record<string, unknown> } {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
}
