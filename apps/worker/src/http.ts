import { createServer, type Server } from 'node:http'
import { PROMETHEUS_CONTENT_TYPE, type MetricsRegistry } from '@relay/core'

export function startMetricsServer(registry: MetricsRegistry, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && path === '/metrics') {
      res.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE }).end(registry.render())
    } else if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    } else {
      res.writeHead(404).end()
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve(server))
  })
}
