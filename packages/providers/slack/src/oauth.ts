import { z } from 'zod'

export const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'
export const SLACK_OAUTH_ACCESS_URL = 'https://slack.com/api/oauth.v2.access'

export const SLACK_USER_SCOPES = [
  'chat:write',
  'im:history',
  'channels:history',
  'groups:history',
  'reactions:write',
  'users:read',
] as const

export function buildAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(SLACK_AUTHORIZE_URL)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('user_scope', SLACK_USER_SCOPES.join(','))
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  return url.toString()
}

const accessResponseSchema = z.discriminatedUnion('ok', [
  z.looseObject({
    ok: z.literal(true),
    authed_user: z.looseObject({
      id: z.string(),
      access_token: z.string(),
      scope: z.string().optional(),
      token_type: z.string().optional(),
    }),
    team: z.looseObject({ id: z.string() }),
  }),
  z.looseObject({ ok: z.literal(false), error: z.string() }),
])

export class SlackOAuthError extends Error {
  override name = 'SlackOAuthError'
}

export interface SlackUserGrant {
  teamId: string
  userId: string
  accessToken: string
  scope: string | null
}

export async function exchangeCode(input: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
  fetch?: typeof fetch
}): Promise<SlackUserGrant> {
  const doFetch = input.fetch ?? fetch
  const res = await doFetch(SLACK_OAUTH_ACCESS_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ code: input.code, redirect_uri: input.redirectUri }).toString(),
  })
  if (!res.ok) throw new SlackOAuthError(`oauth.v2.access HTTP ${res.status}`)
  const parsed = accessResponseSchema.safeParse(await res.json())
  if (!parsed.success) throw new SlackOAuthError('oauth.v2.access returned an unexpected shape')
  const body = parsed.data
  if (!body.ok) throw new SlackOAuthError(`oauth.v2.access error: ${body.error}`)
  return {
    teamId: body.team.id,
    userId: body.authed_user.id,
    accessToken: body.authed_user.access_token,
    scope: body.authed_user.scope ?? null,
  }
}
