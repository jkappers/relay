import { and, eq, isNull, sql } from 'drizzle-orm'
import { AdminError } from './admin'
import type { Db } from './db/client'
import { connectionMembers, connections, destinations, routes } from './db/schema'

export async function isMember(db: Db, userId: string, connectionId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: connectionMembers.role })
    .from(connectionMembers)
    .where(and(eq(connectionMembers.userId, userId), eq(connectionMembers.connectionId, connectionId)))
  return row !== undefined
}

export interface MismatchedLink {
  routeId: string
  routeConnectionId: string | null
  destinationId: string
  destinationConnectionId: string | null
}

export interface AdoptResult {
  connectionsAdopted: string[]
  routesAssigned: string[]
  destinationsAssigned: string[]
  mismatched: MismatchedLink[]
}

/**
 * Pre-accounts data upgrade. Makes `userId` owner of every connection with no members, and moves every
 * route and destination with no connection to `connectionId`. Never deletes or copies rows. Idempotent.
 */
export async function adoptOrphans(db: Pick<Db, 'transaction'>, input: { userId: string; connectionId: string }): Promise<AdoptResult> {
  return db.transaction(async (tx) => {
    const [target] = await tx.select({ id: connections.id }).from(connections).where(eq(connections.id, input.connectionId))
    if (!target) throw new AdminError('connection not found', 'not_found')

    const adopted = await tx.execute<{ connection_id: string }>(sql`
      insert into connection_members (connection_id, user_id, role)
      select c.id, ${input.userId}::uuid, 'owner' from connections c
      where not exists (select 1 from connection_members m where m.connection_id = c.id)
      returning connection_id`)

    const [member] = await tx
      .select({ role: connectionMembers.role })
      .from(connectionMembers)
      .where(and(eq(connectionMembers.userId, input.userId), eq(connectionMembers.connectionId, input.connectionId)))
    if (!member) throw new AdminError('that user is not a member of the target connection', 'invalid')

    const routesAssigned = await tx
      .update(routes)
      .set({ connectionId: input.connectionId, updatedAt: new Date() })
      .where(isNull(routes.connectionId))
      .returning({ id: routes.id })
    const destinationsAssigned = await tx
      .update(destinations)
      .set({ connectionId: input.connectionId, updatedAt: new Date() })
      .where(isNull(destinations.connectionId))
      .returning({ id: destinations.id })

    const mismatched = await tx.execute<{
      route_id: string
      route_connection_id: string | null
      destination_id: string
      destination_connection_id: string | null
    }>(sql`
      select r.id as route_id, r.connection_id as route_connection_id, d.id as destination_id, d.connection_id as destination_connection_id
      from route_destinations rd
      join routes r on r.id = rd.route_id
      join destinations d on d.id = rd.destination_id
      where r.connection_id is distinct from d.connection_id
      order by r.id, d.id`)

    return {
      connectionsAdopted: adopted.map((r) => r.connection_id),
      routesAssigned: routesAssigned.map((r) => r.id),
      destinationsAssigned: destinationsAssigned.map((r) => r.id),
      mismatched: mismatched.map((m) => ({
        routeId: m.route_id,
        routeConnectionId: m.route_connection_id,
        destinationId: m.destination_id,
        destinationConnectionId: m.destination_connection_id,
      })),
    }
  })
}
