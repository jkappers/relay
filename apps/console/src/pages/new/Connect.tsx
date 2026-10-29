import { oauthStartPath, type Viewer } from '../../connect-wizard'
import { Icon } from '../../icons'
import { PROVIDER_NAME, type ProviderId } from '../../integrations'
import { SetupHint } from '../connection-forms'
import { ACTIONS } from './layout'
import { WizardPage } from './parts'

const NEXT: Record<ProviderId, { intro: string; button: string }> = {
  slack: { intro: 'You’ll sign in with Slack and approve access. Relay then opens the new connection.', button: 'Connect Slack' },
  discord: { intro: 'You’ll pick a server you manage and add the Relay bot to it. Relay then opens the new connection.', button: 'Add Discord server' },
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
            <a className="btn btn-primary" href={oauthStartPath(provider)}>
              <Icon name="external" className="size-3.5" />
              {NEXT[provider].button}
            </a>
          ) : (
            <SetupHint provider={provider} viewer={viewer} />
          )}
        </div>
      )}
    </WizardPage>
  )
}
