import { useState } from 'react'
import { connectionsChanged, type SmsCreated, type WebhookCreated } from '../../api'
import type { FormProvider } from '../../connect-wizard'
import { navigate } from '../../hooks'
import { NewSms, NewWebhook, SmsWebhookUrl, WebhookSecret } from '../connection-forms'
import { WizardPage } from './parts'

type Created = { kind: 'webhook'; value: WebhookCreated } | { kind: 'sms'; value: SmsCreated }

const COPY: Record<FormProvider, { title: string; intro: string }> = {
  sms: { title: 'Add SMS', intro: 'Texts to a Twilio number come in, and Relay can reply from it.' },
  webhook: { title: 'Add signed webhook', intro: 'For any service that can send an HTTP POST. You get a URL and a signing secret.' },
}

export function Form({ provider }: { provider: FormProvider }) {
  const [created, setCreated] = useState<Created | null>(null)

  function done() {
    connectionsChanged()
    if (created) navigate(`/c/${created.value.id}`)
  }

  if (created) {
    const webhook = created.kind === 'webhook'
    return (
      <WizardPage
        title={webhook ? 'Webhook created' : 'SMS connection created'}
        intro={webhook ? 'Save the secret now. Send signed requests to the URL.' : 'One more step, in Twilio.'}
      >
        {created.kind === 'webhook' ? (
          <WebhookSecret created={created.value} onDismiss={done} />
        ) : (
          <SmsWebhookUrl created={created.value} onDismiss={done} />
        )}
      </WizardPage>
    )
  }

  return (
    <WizardPage title={COPY[provider].title} intro={COPY[provider].intro} back={{ kind: 'pick' }}>
      {provider === 'webhook' ? (
        <NewWebhook onCreated={(value) => setCreated({ kind: 'webhook', value })} />
      ) : (
        <NewSms onCreated={(value) => setCreated({ kind: 'sms', value })} />
      )}
    </WizardPage>
  )
}
