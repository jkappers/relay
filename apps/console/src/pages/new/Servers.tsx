import { useState } from 'react'
import { ApiError, connectionsChanged, post } from '../../api'
import { Async, Notice } from '../../components'
import { discordInvitePath, discordLinkPath } from '../../connect-wizard'
import { errorText, navigate, useLoad } from '../../hooks'
import { WizardPage } from './parts'

interface Guild {
  id: string
  name: string
  botPresent: boolean
}

export function Servers({ grant }: { grant: string }) {
  const state = useLoad(() => post<{ guilds: Guild[] }>('/oauth/discord/guilds', { grant }), [grant])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ message: string; expired: boolean } | null>(null)

  async function connect(guild: Guild) {
    setBusy(guild.id)
    setError(null)
    try {
      const { id } = await post<{ id: string }>('/oauth/discord/connect', { grant, guildId: guild.id })
      connectionsChanged()
      navigate(`/c/${id}/routes`)
    } catch (e) {
      setError({ message: errorText(e), expired: e instanceof ApiError && e.status === 410 })
      setBusy(null)
    }
  }

  const expired = (state.error && state.data === null && /expired/.test(state.error)) || error?.expired
  return (
    <WizardPage
      title="Choose a Discord server"
      intro="These are the servers where you can manage the server. Relay can already see some of them. For the others, Discord asks you to add the bot."
      back={{ kind: 'connect', provider: 'discord' }}
    >
      {expired ? (
        <Notice tone="error">
          The Discord link expired. <a href={discordLinkPath()}>Link Discord again</a>.
        </Notice>
      ) : (
        <>
          {error ? <Notice tone="error">{error.message}</Notice> : null}
          <Async
            state={state}
            empty={{ when: (d) => d.guilds.length === 0, render: () => <p className="text-ink-2">You don’t manage any Discord servers.</p> }}
          >
            {(d) => (
              <ul aria-label="Discord servers" className="flex flex-col divide-y divide-rule border-y border-rule">
                {d.guilds.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-4 px-3 py-2">
                    <span className="min-w-0 truncate font-semibold">{g.name}</span>
                    {g.botPresent ? (
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void connect(g)}>
                        {busy === g.id ? 'Connecting…' : 'Connect'}
                      </button>
                    ) : (
                      <a className="btn btn-sm" href={discordInvitePath(g.id)}>
                        Add bot
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </>
      )}
    </WizardPage>
  )
}
