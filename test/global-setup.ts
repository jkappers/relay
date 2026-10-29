import { runMigrations } from '@relay/core'
import { TEST_DATABASE_URL } from '@relay/core/testing'

export default async function setup() {
  await runMigrations(TEST_DATABASE_URL)
}
