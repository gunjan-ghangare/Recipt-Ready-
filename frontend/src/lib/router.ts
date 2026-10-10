import { useSyncExternalStore } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'upload' }
  | { name: 'expense'; id: string }
  | { name: 'notFound' }

function parse(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/'
  if (path === '/') return { name: 'home' }
  if (path === '/upload') return { name: 'upload' }
  const match = path.match(/^\/expenses\/([\w-]{1,64})$/)
  if (match) return { name: 'expense', id: match[1] }
  return { name: 'notFound' }
}

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  return parse(hash)
}

export const links = {
  home: '#/',
  upload: '#/upload',
  expense: (id: string) => `#/expenses/${id}`,
}

export function navigate(href: string) {
  window.location.hash = href.replace(/^#/, '')
}
