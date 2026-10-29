import { discordLinkPath, oauthStartPath, type Viewer } from '../../connect-wizard'
import { Icon } from '../../icons'
import { PROVIDER_NAME, type ProviderId } from '../../integrations'
import { SetupHint } from '../connection-forms'
import { ACTIONS } from './layout'
import { WizardPage } from './parts'

const NEXT: Record<ProviderId, { intro: string; button: string }> = {
  slack: { intro: 'You’ll sign in with Slack and approve access. Relay then opens the new connection.', button: 'Connect Slack' },
  discord: { intro: 'Link Discord once to see the servers you manage. Pick one and Relay connects it, adding the bot first if it isn’t there yet.', button: 'Find my servers' },
}

/** `ready` is whether this provider's app has settings. Null until installs load. */
export function Connect({ provider, ready, viewer }: { provider: ProviderId; ready: boolean | null; viewer: Viewer }) {
  const name = PROVIDER_NAME[provider]
  return (
    <WizardPage
      title={`Add ${name}`}
      intro={ready === false ? `${name} isn’t set up on this Relay yet.` : NEXT[provider].intro}
      back={{ kind: 'pick' }}
    >
      {ready === null ? null : (
        <div className={ACTIONS}>
          {ready ? (
            <>
              <a className="btn btn-primary" href={provider === 'discord' ? discordLinkPath() : oauthStartPath(provider)}>
                <Icon name="external" className="size-3.5" />
                {NEXT[provider].button}
              </a>
              {provider === 'discord' ? (
                <a className="btn" href={oauthStartPath(provider)}>
                  Choose the server on Discord
                </a>
              ) : null}
            </>
          ) : (
            <SetupHint provider={provider} viewer={viewer} />
          )}
        </div>
      )}
    </WizardPage>
  )
}
