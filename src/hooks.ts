import { useEffect, useState } from 'react'
import { getBlob } from './db'

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string | undefined>>()

/** Object URL for a stored thumbnail (cached for the session). Loads when `enabled`. */
export function useThumb(id: string, enabled = true): string | undefined {
  const [url, setUrl] = useState<string | undefined>(cache.get(id))
  useEffect(() => {
    if (!enabled || cache.has(id)) { if (cache.has(id)) setUrl(cache.get(id)); return }
    let off = false
    let p = inflight.get(id)
    if (!p) {
      p = getBlob('thumbs', id).then((b) => {
        if (!b) return undefined
        const u = URL.createObjectURL(b)
        cache.set(id, u)
        return u
      }).finally(() => inflight.delete(id))
      inflight.set(id, p)
    }
    p.then((u) => { if (!off) setUrl(u) })
    return () => { off = true }
  }, [id, enabled])
  return url
}

export function dropThumb(id: string) {
  const u = cache.get(id)
  if (u) URL.revokeObjectURL(u)
  cache.delete(id)
}

export function useViewUrl(id: string | undefined, store: 'views' | 'originals' = 'views') {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    setUrl(undefined)
    if (!id) return
    let u: string | undefined
    let off = false
    getBlob(store, id).then((b) => {
      if (b && !off) { u = URL.createObjectURL(b); setUrl(u) }
    })
    return () => { off = true; if (u) URL.revokeObjectURL(u) }
  }, [id, store])
  return url
}

export function useInView<T extends Element>(rootMargin = '800px') {
  const [seen, setSeen] = useState(false)
  const [el, setEl] = useState<T | null>(null)
  useEffect(() => {
    if (!el || seen) return
    if (!('IntersectionObserver' in window)) { setSeen(true); return }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect() } }, { rootMargin })
    io.observe(el)
    return () => io.disconnect()
  }, [el, seen, rootMargin])
  return [setEl, seen] as const
}

export type ThemePref = 'auto' | 'light' | 'dark'
export function useTheme(): [ThemePref, () => void] {
  const [pref, setPref] = useState<ThemePref>(() => (localStorage.getItem('pt.theme') as ThemePref) || 'auto')
  useEffect(() => {
    const dark = () => pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
    const apply = () => {
      document.documentElement.dataset.theme = dark() ? 'dark' : 'light'
      document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark() ? '#0f1117' : '#4f46e5')
    }
    apply()
    localStorage.setItem('pt.theme', pref)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [pref])
  return [pref, () => setPref((p) => (p === 'auto' ? 'light' : p === 'light' ? 'dark' : 'auto'))]
}
