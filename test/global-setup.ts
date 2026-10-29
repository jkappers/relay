import { runMigrations } from '@relay/core'
import { dropAllSchemas, TEST_DATABASE_URL } from '@relay/core/testing'

export default async function setup() {
  // Migrate from zero each run: queue policy is fixed at creation, and the NOT NULL tenancy migration needs no leftover rows.
  await dropAllSchemas(TEST_DATABASE_URL)
  await runMigrations(TEST_DATABASE_URL)
}
