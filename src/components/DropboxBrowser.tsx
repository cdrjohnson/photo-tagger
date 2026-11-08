import { useEffect, useMemo, useRef, useState } from 'react'
import { isDropboxVideo, type DropboxEntry, type DropboxFile } from '../dropbox'
import { useLibrary } from '../store'

/** Photo Tagger's own Dropbox folder browser (replaces the Chooser pop-up). */
export function DropboxBrowser({ onClose }: { onClose: () => void }) {
  const lib = useLibrary()
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<DropboxEntry[] | null>(null)
  const [error, setError] = useState('')
  const [recursive, setRecursive] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const anchor = useRef<number | null>(null)
  const selectAllRef = useRef<() => void>(() => {})
  const inLibrary = useMemo(() => new Set(lib.photos.map((p) => p.dropbox?.id).filter(Boolean) as string[]), [lib.photos])

  useEffect(() => {
    let off = false
    setEntries(null); setError(''); setPicked(new Set()); anchor.current = null
    lib.listDropbox(path).then((e) => { if (!off) setEntries(e) }).catch((e: any) => { if (!off) setError(e?.message || 'Could not list this folder') })
    return () => { off = true }
  }, [path, lib.listDropbox])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      // Ctrl/⌘+A: select all new photos in this folder (not while typing in a field)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !(e.target instanceof HTMLInputElement && e.target.type !== 'checkbox')) { e.preventDefault(); selectAllRef.current() }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const crumbs = path.split('/').filter(Boolean)
  const folders = entries?.filter((e) => e.kind === 'folder') ?? []
  const images = entries?.filter((e) => e.kind === 'file') ?? []
  const freshFiles = images.filter((e) => !inLibrary.has(e.id)) as DropboxFile[]
  const fresh = freshFiles.length
  const chosen = freshFiles.filter((f) => picked.has(f.id))
  selectAllRef.current = () => setPicked(new Set(freshFiles.map((f) => f.id)))
  // modern file-list selection: click = only this, Ctrl/Cmd-click = toggle, Shift-click = range
  // (deselects the range if that file was already selected), drag across rows = paint a range
  const drag = useRef<{ from: number; base: Set<string>; remove: boolean } | null>(null)
  const rangeIds = (a: number, b: number) => { const [x, y] = [a, b].sort((m, n) => m - n); return images.slice(x, y + 1).filter((f) => !inLibrary.has(f.id)).map((f) => f.id) }
  const apply = (base: Set<string>, ids: string[], remove: boolean) => { const n = new Set(base); ids.forEach((id) => (remove ? n.delete(id) : n.add(id))); return n }
  const press = (i: number, id: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; onCheckbox?: boolean }) => {
    const from = anchor.current
    let next: Set<string>, remove = false, dragFrom = i, base: Set<string>
    if (e.shiftKey && from != null) {
      remove = picked.has(id); base = new Set(picked); dragFrom = from
      next = apply(base, rangeIds(from, i), remove)
    } else if (e.ctrlKey || e.metaKey || e.onCheckbox) {
      remove = picked.has(id); base = new Set(picked)
      next = apply(base, [id], remove)
      anchor.current = i
    } else {
      base = new Set(); next = new Set([id])
      anchor.current = i
    }
    setPicked(next)
    drag.current = { from: dragFrom, base, remove }
  }
  const enter = (i: number) => { const d = drag.current; if (d) setPicked(apply(d.base, rangeIds(d.from, i), d.remove)) }
  useEffect(() => {
    const up = () => { drag.current = null }
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
  }, [])
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
        <div className="dbx-list" data-testid="dropbox-list" role="listbox" aria-multiselectable="true" aria-label="Folders and photos">
          {error && <p className="note warn" data-testid="dropbox-error">{error}</p>}
          {!entries && !error && <p className="muted">Loading…</p>}
          {entries && !entries.length && <p className="muted">This folder has no subfolders or images.</p>}
          {folders.map((f) => (
            <button key={f.id} className="dbx-row" data-testid="dropbox-folder" data-name={f.name} onClick={() => setPath(f.path)}>📁 <span>{f.name}</span></button>
          ))}
          {images.map((f, i) => {
            const file = f as DropboxFile
            const have = inLibrary.has(f.id), on = picked.has(f.id)
            const body = (<>
              <input type="checkbox" tabIndex={-1} checked={have || on} readOnly disabled={have} aria-label={have ? `${f.name} is already in the library` : `Select ${f.name}`} data-testid="dropbox-file-check" />
              <PickerThumb f={file} />
              <span className="dbx-file-text">
                <span className="dbx-file-name" title={f.name}>{isDropboxVideo(f.name) ? '🎬 ' : ''}{f.name}</span>
                <small className="muted dbx-file-meta" data-testid="dropbox-file-meta">{[fmtDate(file), fmtBytes(file.size)].filter(Boolean).join(' · ')}</small>
                {have && <small className="dbx-have" data-testid="dropbox-in-library">Already in library</small>}
              </span>
            </>)
            return have ? (
              <div key={f.id} className="dbx-row file have" data-testid="dropbox-file" data-name={f.name} aria-disabled="true">{body}</div>
            ) : (
              <div key={f.id} className={`dbx-row file pickable ${on ? 'on' : ''}`} data-testid="dropbox-file" data-name={f.name} data-picked={on ? '1' : '0'}
                role="option" aria-selected={on} tabIndex={0}
                onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); (e.currentTarget as HTMLElement).focus(); press(i, f.id, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, onCheckbox: (e.target as HTMLElement).tagName === 'INPUT' }) }}
                onPointerEnter={() => enter(i)}
                onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); press(i, f.id, { shiftKey: e.shiftKey, ctrlKey: true, metaKey: false }); drag.current = null } }}>
                {body}</div>
            )
          })}
          {fresh > 0 && (
            <div className="row wrap dbx-pick-bar">
              <small className="muted grow" data-testid="dropbox-selected-count">{chosen.length ? `${chosen.length} selected` : 'Pick photos: click, Ctrl/⌘-click to add, Shift-click or drag for a range'}</small>
              <button className="btn small" data-testid="dropbox-select-all" onClick={() => setPicked(new Set(freshFiles.map((f) => f.id)))}>Select all</button>
              <button className="btn small" data-testid="dropbox-deselect-all" disabled={!chosen.length} onClick={() => setPicked(new Set())}>Deselect all</button>
            </div>
          )}
        </div>
        <label className="check" style={chosen.length ? { opacity: 0.55 } : undefined}>
          <input type="checkbox" disabled={chosen.length > 0} checked={recursive} onChange={(e) => setRecursive(e.target.checked)} data-testid="dropbox-recursive" />
          <span>Include subfolders <small>Off by default so you don’t tag your whole Dropbox by accident. Only for tagging the whole folder, not picked photos.</small></span>
        </label>
        <div className="row wrap">
          <button className="btn primary" data-testid="dropbox-process" disabled={busy || !!error || !entries}
            onClick={() => { void (chosen.length ? lib.processDropboxFiles(chosen) : lib.processDropboxFolder(path, recursive)); onClose() }}>
            {chosen.length ? `Tag ${chosen.length} selected photo(s)` : `Tag ${recursive ? 'this folder and subfolders' : `${fresh} new photo(s) here`}`}
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

const fmtBytes = (n?: number) => (!n ? '' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)
function fmtDate(f: DropboxFile): string {
  let d = f.clientModified ? new Date(f.clientModified) : null
  if (!d || isNaN(+d)) { const m = f.name.match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/); d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : null }
  return d && !isNaN(+d) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
}
/** Dropbox preview, fetched only when the row scrolls into view (the list never prefetches a whole folder) */
function PickerThumb({ f }: { f: DropboxFile }) {
  const lib = useLibrary()
  const ref = useRef<HTMLSpanElement>(null)
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    const el = ref.current; if (!el) return
    let off = false
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return
      io.disconnect()
      void lib.dropboxThumb(f).then((u) => { if (!off) setUrl(u) }).catch(() => { if (!off) setUrl(null) })
    }, { rootMargin: '120px' })
    io.observe(el)
    return () => { off = true; io.disconnect() }
  }, [f.id, f.rev]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={ref} className="dbx-thumb" data-testid="dropbox-thumb" data-state={url ? 'loaded' : url === null ? 'failed' : 'waiting'} aria-hidden="true">
      {url ? <img src={url} alt="" draggable={false} /> : <span className="dbx-thumb-ph">{isDropboxVideo(f.name) ? '🎬' : '🖼'}</span>}
    </span>
  )
}
