import { useEffect } from 'react'
import { guard, newPath, parseNewPath, type Viewer } from '../../connect-wizard'
import { useInstalls } from '../connection-forms'
import { Connect } from './Connect'
import { Form } from './Form'
import { Pick } from './Pick'
import { Setup } from './Setup'

/** The `#/new...` pages: pick a provider, then set it up or connect it. */
export function NewFlow({ path, viewer }: { path: string; viewer: Viewer }) {
  const installs = useInstalls()
  const parsed = parseNewPath(path)
  const route = parsed && guard(parsed, installs, viewer)
  const target = route ? newPath(route) : '/new'

  useEffect(() => {
    if (target !== path) window.location.replace(`#${target}`)
  }, [target, path])

  if (!route || target !== path) return null
  switch (route.kind) {
    case 'pick':
      return <Pick installs={installs} viewer={viewer} />
    case 'form':
      return <Form key={route.provider} provider={route.provider} />
    case 'connect':
      return <Connect provider={route.provider} ready={installs ? installs[route.provider] !== null : null} viewer={viewer} />
    case 'setup':
      return <Setup provider={route.provider} ready={installs?.[route.provider] != null} />
  }
}
