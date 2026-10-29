import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: process.env.RELAY_DRIZZLE_OUT ?? './drizzle',
})
