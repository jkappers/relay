import { connectionsChanged, get } from '../../api'
import { Async, SkeletonRows } from '../../components'
import { useLoad } from '../../hooks'
import { PROVIDER_NAME, type IntegrationsView, type ProviderId } from '../../integrations'
import { ProviderCard } from '../Integrations'
import { ACTIONS } from './layout'
import { WizardPage } from './parts'

/** Admin-only, once per instance: the provider's app settings. */
export function Setup({ provider, ready }: { provider: ProviderId; ready: boolean }) {
  const state = useLoad(() => get<IntegrationsView>('/api/admin/integrations'), [])
  const onChanged = () => {
    state.reload()
    connectionsChanged()
  }
  const name = PROVIDER_NAME[provider]
  return (
    <WizardPage title={`Set up ${name}`} intro={`Once per Relay. Everyone then connects through this ${name} app.`} back={{ kind: 'pick' }}>
      <Async state={state} skeleton={<SkeletonRows rows={4} />}>
        {(d) => <ProviderCard bare view={d.providers[provider]} onChanged={onChanged} />}
      </Async>
      {ready ? (
        <div className={ACTIONS}>
          <a className="btn btn-primary" href={`#/new/${provider}`}>
            Continue
          </a>
        </div>
      ) : null}
    </WizardPage>
  )
}
