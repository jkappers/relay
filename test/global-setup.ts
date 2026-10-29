import { runMigrations } from '@relay/core'
import { dropQueueSchema, TEST_DATABASE_URL } from '@relay/core/testing'

export default async function setup() {
  // Queue policy is fixed at creation, so start each run with a fresh pg-boss schema.
  await dropQueueSchema(TEST_DATABASE_URL)
  await runMigrations(TEST_DATABASE_URL)
}
