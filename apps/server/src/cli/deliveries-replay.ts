import { z } from 'zod'
import { QUEUES, replayDelivery } from '@relay/core'
import { runCli, withQueue } from './util'

await runCli(({ db, config }) => {
  const id = z.uuid().parse(process.argv[2])
  return withQueue(config, QUEUES.dispatch, async (queue) => {
    await replayDelivery(db, queue, id)
    console.log(`delivery ${id} set to pending and queued`)
  })
})
