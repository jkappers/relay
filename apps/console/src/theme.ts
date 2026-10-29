import { useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'relay-theme'

function read(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
}

export function initTheme() {
  apply(read())
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(read)
  const set = (c: ThemeChoice) => {
    setChoice(c)
    apply(c)
    try {
      if (c === 'system') window.localStorage.removeItem(KEY)
      else window.localStorage.setItem(KEY, c)
    } catch {
      return
    }
  }
  return [choice, set]
}
