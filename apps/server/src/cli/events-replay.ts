import { z } from 'zod'
import { QUEUES, replayEvent } from '@relay/core'
import { runCli, withQueue } from './util'

await runCli(({ db, config }) => {
  const id = z.uuid().parse(process.argv[2])
  return withQueue(config, QUEUES.route, async (queue) => {
    await replayEvent(db, queue, id)
    console.log(`event ${id} queued for routing. Only new route matches create deliveries.`)
  })
})
