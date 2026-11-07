import { useEffect, useMemo, useState } from 'react'
import type { DropboxEntry } from '../dropbox'
import { useLibrary } from '../store'

/** Photo Tagger's own Dropbox folder browser (replaces the Chooser pop-up). */
export function DropboxBrowser({ onClose }: { onClose: () => void }) {
  const lib = useLibrary()
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<DropboxEntry[] | null>(null)
  const [error, setError] = useState('')
  const [recursive, setRecursive] = useState(false)
  const inLibrary = useMemo(() => new Set(lib.photos.map((p) => p.dropbox?.id).filter(Boolean) as string[]), [lib.photos])

  useEffect(() => {
    let off = false
    setEntries(null); setError('')
    lib.listDropbox(path).then((e) => { if (!off) setEntries(e) }).catch((e: any) => { if (!off) setError(e?.message || 'Could not list this folder') })
    return () => { off = true }
  }, [path, lib.listDropbox])

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const crumbs = path.split('/').filter(Boolean)
  const folders = entries?.filter((e) => e.kind === 'folder') ?? []
  const images = entries?.filter((e) => e.kind === 'file') ?? []
  const fresh = images.filter((e) => !inLibrary.has(e.id)).length
  const busy = !!lib.job?.cancellable

  return (
    <div className="modal sheet" role="dialog" aria-modal="true" aria-labelledby="dbx-title" data-testid="dropbox-browser">
      <div className="sheet-card dbx-card">
        <div className="settings-head">
          <h2 id="dbx-title">Dropbox{lib.dropbox.account ? <small className="muted"> · {lib.dropbox.account}</small> : null}</h2>
          <button className="btn icon" aria-label="Close" data-testid="dropbox-browser-close" onClick={onClose}>✕</button>
        </div>
        <nav className="dbx-crumbs" aria-label="Folder path" data-testid="dropbox-crumbs">
          <button className="linkish" data-testid="dropbox-crumb" onClick={() => setPath('')}>Dropbox</button>
          {crumbs.map((c, i) => (
            <span key={i}> / <button className="linkish" data-testid="dropbox-crumb" onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>
          ))}
        </nav>
        <div className="dbx-list" data-testid="dropbox-list">
          {error && <p className="note warn" data-testid="dropbox-error">{error}</p>}
          {!entries && !error && <p className="muted">Loading…</p>}
          {entries && !entries.length && <p className="muted">This folder has no subfolders or images.</p>}
          {folders.map((f) => (
            <button key={f.id} className="dbx-row" data-testid="dropbox-folder" data-name={f.name} onClick={() => setPath(f.path)}>📁 <span>{f.name}</span></button>
          ))}
          {images.map((f) => (
            <div key={f.id} className="dbx-row file" data-testid="dropbox-file" data-name={f.name}>🖼 <span>{f.name}</span>
              {inLibrary.has(f.id) && <small className="muted" data-testid="dropbox-in-library">in library</small>}</div>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} data-testid="dropbox-recursive" />
          <span>Include subfolders <small>Off by default so you don’t tag your whole Dropbox by accident.</small></span>
        </label>
        <div className="row wrap">
          <button className="btn primary" data-testid="dropbox-process" disabled={busy || !!error || !entries}
            onClick={() => { void lib.processDropboxFolder(path, recursive); onClose() }}>
            Tag {recursive ? 'this folder and subfolders' : `${fresh} new photo(s) here`}
          </button>
          {lib.dropbox.folders.length > 0 && (
            <button className="btn" data-testid="dropbox-refresh" disabled={busy} onClick={() => { void lib.refreshDropbox(); onClose() }}>
              ↻ Refresh linked folders ({lib.dropbox.folders.length})</button>
          )}
        </div>
        {lib.dropbox.folders.length > 0 && (
          <details className="muted" data-testid="dropbox-linked">
            <summary>Linked folders</summary>
            <ul>{lib.dropbox.folders.map((f) => (
              <li key={f.path}><code>{f.path || '/'}</code>{f.recursive ? ' (with subfolders)' : ''}{' '}
                <button className="linkish" onClick={() => void lib.forgetDropboxFolder(f.path)}>forget</button></li>
            ))}</ul>
          </details>
        )}
        <p className="muted"><small>Photos stay in Dropbox. Each image is downloaded into memory to tag it, then discarded; tags and face names are saved to /.photo-tagger in your Dropbox — nothing is kept on this device.</small></p>
      </div>
    </div>
  )
}
