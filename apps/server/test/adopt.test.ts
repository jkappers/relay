import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { eq, sql } from 'drizzle-orm'
import { adoptOrphans, schema, type Db } from '@relay/core'
import { TEST_DATABASE_URL, TEST_MASTER_KEY } from '@relay/core/testing'
import { describe, expect, it } from 'vitest'
import { scryptHasher } from '../src/accounts/password'
import { createUser } from '../src/accounts/users'
import { PASSWORD, useHarness } from './harness'

const h = useHarness()
const run = promisify(execFile)
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))

async function adoptCli(email: string, connectionId: string) {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', 'src/cli/tenancy-adopt.ts', '--email', email, '--connection', connectionId], {
      cwd: SERVER_DIR,
      env: { PATH: process.env.PATH, DATABASE_URL: TEST_DATABASE_URL, RELAY_MASTER_KEY: Buffer.from(TEST_MASTER_KEY).toString('base64') },
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string }
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

const newConnection = async (db: Pick<Db, 'insert'>) => (await db.insert(schema.connections).values({ provider: 'webhook' }).returning())[0]!.id
const newDestination = async (db: Pick<Db, 'insert'>, connectionId: string | null) =>
  (await db.insert(schema.destinations).values({ connectionId: connectionId as string, name: 'd', kind: 'agent', config: { systemPrompt: 'x' } }).returning())[0]!.id
const newRoute = async (db: Pick<Db, 'insert'>, connectionId: string | null, destinationIds: string[]) => {
  const [route] = await db.insert(schema.routes).values({ connectionId: connectionId as string, name: 'r', eventType: '*' }).returning()
  for (const destinationId of destinationIds) await db.insert(schema.routeDestinations).values({ routeId: route!.id, destinationId })
  return route!.id
}

describe('tenancy:adopt', () => {
  it('moves pre-accounts rows onto one owner and one connection, reports crossed links, and is a no-op the second time', async () => {
    const owner = await createUser(h.db, scryptHasher, { email: 'owner@example.com', password: PASSWORD })
    const other = await createUser(h.db, scryptHasher, { email: 'other@example.com', password: PASSWORD })
    const rollback = new Error('rollback')
    await expect(
      h.db.transaction(async (tx) => {
        // Recreate the state between migration 1 and 2, inside a transaction that never commits.
        await tx.execute(sql`alter table routes alter column connection_id drop not null`)
        await tx.execute(sql`alter table destinations alter column connection_id drop not null`)
        const target = await newConnection(tx)
        const legacy = await newConnection(tx)
        const owned = await newConnection(tx)
        await tx.insert(schema.connectionMembers).values({ connectionId: owned, userId: other.id })
        const orphanDest = await newDestination(tx, null)
        const orphanRoute = await newRoute(tx, null, [orphanDest])
        const filteredDest = await newDestination(tx, null)
        const filteredRoute = await newRoute(tx, legacy, [filteredDest])

        const first = await adoptOrphans(tx, { userId: owner.id, connectionId: target })
        expect(first.connectionsAdopted.sort()).toEqual([target, legacy].sort())
        expect(first.routesAssigned).toEqual([orphanRoute])
        expect(first.destinationsAssigned.sort()).toEqual([orphanDest, filteredDest].sort())
        expect(first.mismatched).toEqual([{ routeId: filteredRoute, routeConnectionId: legacy, destinationId: filteredDest, destinationConnectionId: target }])
        const [r] = await tx.select().from(schema.routes).where(eq(schema.routes.id, orphanRoute))
        expect(r!.connectionId).toBe(target)
        const members = await tx.select().from(schema.connectionMembers).where(eq(schema.connectionMembers.connectionId, owned))
        expect(members.map((m) => m.userId)).toEqual([other.id])

        const second = await adoptOrphans(tx, { userId: owner.id, connectionId: target })
        expect(second).toEqual({ connectionsAdopted: [], routesAssigned: [], destinationsAssigned: [], mismatched: first.mismatched })
        throw rollback
      }),
    ).rejects.toBe(rollback)
  })

  it('refuses a target connection the user does not belong to', async () => {
    const owner = await createUser(h.db, scryptHasher, { email: 'owner@example.com', password: PASSWORD })
    const other = await createUser(h.db, scryptHasher, { email: 'other@example.com', password: PASSWORD })
    const target = await newConnection(h.db)
    await h.db.insert(schema.connectionMembers).values({ connectionId: target, userId: other.id })
    await expect(adoptOrphans(h.db, { userId: owner.id, connectionId: target })).rejects.toThrow(/not a member/)
    expect(await h.db.select().from(schema.connectionMembers)).toHaveLength(1)
  })

  it('the CLI exits non-zero while a route links across connections, and 0 once fixed', async () => {
    await createUser(h.db, scryptHasher, { email: 'owner@example.com', password: PASSWORD })
    const target = await newConnection(h.db)
    const elsewhere = await newConnection(h.db)
    const dest = await newDestination(h.db, elsewhere)
    const route = await newRoute(h.db, target, [dest])

    const first = await adoptCli('owner@example.com', target)
    expect(first.code).toBe(2)
    expect(first.stdout).toContain('connections now owned by owner@example.com: 2')
    expect(first.stderr).toContain(route)
    expect(first.stderr).toContain(dest)

    const again = await adoptCli('owner@example.com', target)
    expect(again.code).toBe(2)
    expect(again.stdout).toContain('connections now owned by owner@example.com: 0')

    await h.db.update(schema.destinations).set({ connectionId: target }).where(eq(schema.destinations.id, dest))
    const fixed = await adoptCli('owner@example.com', target)
    expect(fixed.code).toBe(0)
    expect(fixed.stdout).toContain('no route links cross connections')
  })

  it('the CLI fails for an unknown email', async () => {
    const target = await newConnection(h.db)
    const res = await adoptCli('ghost@example.com', target)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('no user with email')
  })
})
