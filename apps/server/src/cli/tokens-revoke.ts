import { z } from 'zod'
import { revokeReplyToken } from '@relay/core'
import { runCli } from './util'

await runCli(async ({ db }) => {
  const jti = z.string().min(1).parse(process.argv[2])
  await revokeReplyToken(db, jti)
  console.log(`token ${jti} revoked`)
})
