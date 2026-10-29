import type { InstallUrls } from '../../api'
import type { Viewer } from '../../connect-wizard'
import { ProviderList, WizardPage } from './parts'

export function Pick({ installs, viewer }: { installs: InstallUrls | null; viewer: Viewer }) {
  return (
    <WizardPage
      title="New connection"
      intro="A connection is a line that brings events in. Its routes, destinations, and events belong to it alone. Choose where events come from."
      back="/"
    >
      <ProviderList installs={installs} viewer={viewer} />
    </WizardPage>
  )
}
