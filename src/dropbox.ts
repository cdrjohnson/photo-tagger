// Dropbox Chooser (https://www.dropbox.com/developers/chooser). Runs fully in the browser:
// the Chooser returns temporary direct links; we fetch each file into a Blob and store it locally.
export const ENV_DROPBOX_KEY: string = (import.meta.env.VITE_DROPBOX_APP_KEY as string | undefined) ?? ''

export interface DropboxChoice { name: string; link: string; bytes: number }

declare global {
  interface Window {
    Dropbox?: {
      choose: (o: {
        success: (files: DropboxChoice[]) => void
        cancel?: () => void
        linkType: 'direct' | 'preview'
        multiselect?: boolean
        extensions?: string[]
        sizeLimit?: number
      }) => void
    }
  }
}

let loadedKey = ''
let loading: Promise<void> | null = null

/** Inject the Chooser script (must be loaded before the click so the pop-up is not blocked). */
export function loadDropbox(appKey: string): Promise<void> {
  if (!appKey) return Promise.reject(new Error('no-key'))
  if (loading && loadedKey === appKey) return loading
  document.getElementById('dropboxjs')?.remove()
  loadedKey = appKey
  loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.id = 'dropboxjs'
    s.src = 'https://www.dropbox.com/static/api/2/dropins.js'
    s.dataset.appKey = appKey
    s.onload = () => resolve()
    s.onerror = () => { loading = null; reject(new Error('Could not load the Dropbox Chooser (are you offline?)')) }
    document.head.appendChild(s)
  })
  return loading
}

export function chooseFromDropbox(): Promise<DropboxChoice[]> {
  return new Promise((resolve, reject) => {
    if (!window.Dropbox) return reject(new Error('Dropbox Chooser is not loaded yet.'))
    window.Dropbox.choose({
      linkType: 'direct',
      multiselect: true,
      extensions: ['images'],
      success: resolve,
      cancel: () => resolve([]),
    })
  })
}

export async function downloadChoice(c: DropboxChoice, signal?: AbortSignal): Promise<File> {
  const r = await fetch(c.link, signal ? { signal } : undefined)
  if (!r.ok) throw new Error(`Dropbox download failed (${r.status})`)
  const blob = await r.blob()
  const type = blob.type && blob.type.startsWith('image/') ? blob.type : guessType(c.name)
  return new File([blob], c.name, { type, lastModified: 0 })
}

function guessType(name: string) {
  const e = name.split('.').pop()?.toLowerCase()
  return e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : e === 'gif' ? 'image/gif' : 'image/jpeg'
}
