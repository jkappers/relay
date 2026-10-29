import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'

export const NON_SPA_PREFIXES = ['/api', '/hooks', '/oauth', '/actions', '/metrics', '/healthz'] as const

export const consoleHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
  referrerPolicy: 'no-referrer',
  xContentTypeOptions: true,
  xFrameOptions: 'DENY',
})

const isReserved = (path: string) => NON_SPA_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))

export function consoleStatic(distDir: string) {
  const indexPath = join(distDir, 'index.html')
  return new Hono()
    .use('*', async (c, next) => {
      if (isReserved(c.req.path) || c.req.method !== 'GET') return next()
      return serveStatic({ root: distDir })(c, next)
    })
    .get('*', async (c, next) => {
      if (isReserved(c.req.path)) return next()
      try {
        return c.html(await readFile(indexPath, 'utf8'))
      } catch {
        return c.text('console is not built; run pnpm --filter @relay/console build', 503)
      }
    })
}
