import { useState } from 'react'
import type { WebhookCreated } from '../api'
import { Icon, RelayMark } from '../icons'
import { connectionsChanged, NewWebhook, SetupHint, useInstalls, WebhookSecret, type Viewer } from './Connections'

export function Onboarding({ email, viewer, onSignOut }: { email: string; viewer: Viewer; onSignOut: () => void }) {
  const [created, setCreated] = useState<WebhookCreated | null>(null)
  const installs = useInstalls()

  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr] bg-ground">
      <header className="flex h-12 items-center justify-between gap-3 border-b border-rule bg-rail px-4">
        <span className="flex items-center gap-2">
          <RelayMark className="size-5" />
          <span className="font-semibold tracking-tight">Relay</span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-xs text-ink-3">{email}</span>
          {viewer.isAdmin ? (
            <a className="btn btn-quiet btn-sm" href="#/settings">
              <Icon name="settings" className="size-3.5" />
              Settings
            </a>
          ) : null}
          <button type="button" className="btn btn-quiet btn-sm" onClick={onSignOut}>
            <Icon name="exit" className="size-3.5" />
            Sign out
          </button>
        </span>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-xl px-4 pt-[10vh] pb-10 outline-none">
        <h1 className="text-lg font-semibold tracking-tight">Add a connection</h1>
        <p className="mt-1 max-w-[60ch] text-ink-2">
          A connection is a line that brings events in. Its routes, destinations, and events belong to it alone. Add one to start.
        </p>
        {created ? (
          <div className="mt-4">
            <WebhookSecret created={created} onDismiss={connectionsChanged} />
          </div>
        ) : (
          <div className="mt-4 flex flex-col divide-y divide-rule border-y border-rule">
            {installs ? (
              <section aria-labelledby="slack-title" className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div className="min-w-0">
                  <h2 id="slack-title" className="font-semibold">
                    Slack
                  </h2>
                  <p className="text-ink-2">Sign in with Slack. Relay gets your messages and can reply as you.</p>
                </div>
                {installs.slack ? (
                  <a className="btn" href="/oauth/slack/start">
                    <Icon name="external" className="size-3.5" />
                    Connect Slack
                  </a>
                ) : (
                  <SetupHint provider="slack" viewer={viewer} />
                )}
              </section>
            ) : null}
            {installs ? (
              <section aria-labelledby="discord-title" className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div className="min-w-0">
                  <h2 id="discord-title" className="font-semibold">
                    Discord
                  </h2>
                  <p className="text-ink-2">Add the Relay bot to a server. It gets DMs and messages that mention it, and replies as the bot.</p>
                </div>
                {installs.discord ? (
                  <a className="btn" href="/oauth/discord/start">
                    <Icon name="external" className="size-3.5" />
                    Add Discord server
                  </a>
                ) : (
                  <SetupHint provider="discord" viewer={viewer} />
                )}
              </section>
            ) : null}
            <section aria-labelledby="webhook-title" className="flex flex-col gap-2 py-4">
              <div>
                <h2 id="webhook-title" className="font-semibold">
                  Signed webhook
                </h2>
                <p className="text-ink-2">For any service that can send an HTTP POST. You get a URL and a signing secret.</p>
              </div>
              <NewWebhook onCreated={setCreated} />
            </section>
          </div>
        )}
      </main>
    </div>
  )
}
