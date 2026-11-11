import { useEffect, useMemo, useRef, useState } from 'react'
import { dropboxFileDate, isDropboxVideo, type DropboxAddOrder, type DropboxEntry, type DropboxFile } from '../dropbox'
import { skippedFiles, useLibrary, type FolderProgress } from '../store'

/** rows taller lists switch to windowed rendering (only what's on screen is in the DOM) */
const VIRTUAL_AFTER = 300
const ROW_H = 68
const PRESETS = [25, 50, 100, 250, 500]

/** Photo Tagger's own Dropbox folder browser (replaces the Chooser pop-up). */
export function DropboxBrowser({ onClose }: { onClose: () => void }) {
  const lib = useLibrary()
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<DropboxEntry[] | null>(null)
  const [error, setError] = useState('')
  const [recursive, setRecursive] = useState(false)
  /** picked file ids and picked subfolders ('dir:' + path) */
  const [picked, setPicked] = useState<Set<string>>(new Set())
  /** how many "Add next batch" adds (1.0.30): defaults to Settings → Dropbox → Photos per batch */
  const [addCount, setAddCount] = useState(() => Math.max(1, lib.settings.dropboxBatchSize || 100))
  const anchor = useRef<number | null>(null)
  const selectAllRef = useRef<() => void>(() => {})
  const listRef = useRef<HTMLDivElement>(null)
  const filesRef = useRef<HTMLDivElement>(null)
  const [win, setWin] = useState({ from: 0, to: VIRTUAL_AFTER })
  const inLibrary = useMemo(() => new Set(lib.photos.map((p) => p.dropbox?.id).filter(Boolean) as string[]), [lib.photos])

  useEffect(() => {
    let off = false
    setEntries(null); setError(''); setPicked(new Set()); anchor.current = null
    if (listRef.current) listRef.current.scrollTop = 0
    lib.listDropbox(path).then((e) => { if (!off) setEntries(e) }).catch((e: any) => { if (!off) setError(e?.message || 'Could not list this folder') })
    return () => { off = true }
  }, [path, lib.listDropbox])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      // Ctrl/⌘+A: select all new photos in this folder (not while typing in a field)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !((e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') || e.target instanceof HTMLSelectElement)) { e.preventDefault(); selectAllRef.current() }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const crumbs = path.split('/').filter(Boolean)
  const folders = useMemo(() => entries?.filter((e) => e.kind === 'folder') ?? [], [entries])
  const images = useMemo(() => (entries?.filter((e) => e.kind === 'file') ?? []) as DropboxFile[], [entries])
  const freshFiles = useMemo(() => images.filter((e) => !inLibrary.has(e.id)), [images, inLibrary])
  const fresh = freshFiles.length
  const chosen = freshFiles.filter((f) => picked.has(f.id))
  const chosenDirs = folders.filter((f) => picked.has('dir:' + f.path)).map((f) => f.path)
  const nPicked = chosen.length + chosenDirs.length
  const selectAll = () => setPicked(new Set([...freshFiles.map((f) => f.id), ...folders.map((f) => 'dir:' + f.path)]))
  selectAllRef.current = selectAll
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
  const toggleDir = (p: string) => setPicked((s) => { const n = new Set(s); const k = 'dir:' + p; if (n.has(k)) n.delete(k); else n.add(k); return n })
  useEffect(() => {
    const up = () => { drag.current = null }
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
  }, [])
  const busy = !!lib.job?.cancellable
  const skipped = useMemo(() => skippedFiles(), [lib.photos, entries])

  // windowed file list for big folders (2,000+ items stay smooth)
  const virtual = images.length > VIRTUAL_AFTER
  useEffect(() => {
    const el = listRef.current; if (!el || !virtual) return
    const calc = () => {
      const top = (filesRef.current?.offsetTop ?? 0)
      const a = Math.floor((el.scrollTop - top) / ROW_H) - 10, b = Math.ceil((el.scrollTop + el.clientHeight - top) / ROW_H) + 10
      setWin((w) => { const from = Math.max(0, a), to = Math.min(images.length, Math.max(from + 1, b)); return w.from === from && w.to === to ? w : { from, to } })
    }
    calc()
    el.addEventListener('scroll', calc, { passive: true })
    const ro = new ResizeObserver(calc); ro.observe(el)
    return () => { el.removeEventListener('scroll', calc); ro.disconnect() }
  }, [virtual, images.length, folders.length])
  const from = virtual ? win.from : 0, to = virtual ? win.to : images.length

  const fileRow = (file: DropboxFile, i: number) => {
    const have = inLibrary.has(file.id), on = picked.has(file.id)
    const body = (<>
      <input type="checkbox" tabIndex={-1} checked={have || on} readOnly disabled={have} aria-label={have ? `${file.name} is already in the library` : `Select ${file.name}`} data-testid="dropbox-file-check" />
      <PickerThumb f={file} />
      <span className="dbx-file-text">
        <span className="dbx-file-name" title={file.name}>{isDropboxVideo(file.name) ? '🎬 ' : ''}{file.name}</span>
        <small className="muted dbx-file-meta" data-testid="dropbox-file-meta">{[fmtDate(file), fmtBytes(file.size)].filter(Boolean).join(' · ')}</small>
        {have && <small className="dbx-have" data-testid="dropbox-in-library">Already in library</small>}
        {!have && skipped[file.id] && <small className="muted" data-testid="dropbox-skipped">Skipped before ({skipped[file.id]})</small>}
      </span>
    </>)
    return have ? (
      <div key={file.id} className="dbx-row file have" data-testid="dropbox-file" data-name={file.name} aria-disabled="true">{body}</div>
    ) : (
      <div key={file.id} className={`dbx-row file pickable ${on ? 'on' : ''}`} data-testid="dropbox-file" data-name={file.name} data-picked={on ? '1' : '0'}
        role="option" aria-selected={on} tabIndex={0}
        onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); (e.currentTarget as HTMLElement).focus(); press(i, file.id, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, onCheckbox: (e.target as HTMLElement).tagName === 'INPUT' }) }}
        onPointerEnter={() => enter(i)}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); press(i, file.id, { shiftKey: e.shiftKey, ctrlKey: true, metaKey: false }); drag.current = null } }}>
        {body}</div>
    )
  }

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
        {entries && !error && (
          <div className="dbx-add-opts" data-testid="dropbox-add-options">
            <AddCount value={addCount} onChange={setAddCount} batch={lib.settings.dropboxBatchSize || 100} />
            <label className="dbx-opt">Order
              <select data-testid="add-order" value={lib.settings.dropboxAddOrder ?? 'name'} onChange={(e) => void lib.saveSettings({ dropboxAddOrder: e.target.value as DropboxAddOrder })}
                title="Which photos “Add next batch” takes first. Dates are the ones Dropbox lists (time taken when Dropbox knows it, else last modified).">
                <option value="name">Name</option><option value="oldest">Oldest first</option><option value="newest">Newest first</option>
              </select>
            </label>
          </div>
        )}
        {entries && !error && path && <div className="dbx-here" data-testid="dropbox-here-progress"><b>This folder:</b> <FolderImport key={path} path={path} recursive={recursive} busy={busy} count={addCount} onStart={onClose} /></div>}
        {entries && !error && <DateRange path={path} recursive={recursive} busy={busy} onStart={onClose} />}
        {(fresh > 0 || folders.length > 0) && (
          <div className="row wrap dbx-pick-bar">
            <small className="muted grow" data-testid="dropbox-selected-count">{nPicked ? `${nPicked} selected${chosenDirs.length ? ` (${chosen.length} ${chosen.length === 1 ? 'photo/video' : 'photos/videos'}, ${chosenDirs.length} folder${chosenDirs.length === 1 ? '' : 's'})` : ''}` : 'Tick photos, videos or folders: click, Ctrl/⌘-click to add, Shift-click or drag for a range'}</small>
            <button className="btn small" data-testid="dropbox-select-all" onClick={selectAll}>Select all</button>
            <button className="btn small" data-testid="dropbox-deselect-all" disabled={!nPicked} onClick={() => setPicked(new Set())}>Select none</button>
          </div>
        )}
        <div className={`dbx-list ${virtual ? 'virt' : ''}`} ref={listRef} data-testid="dropbox-list" role="listbox" aria-multiselectable="true" aria-label="Folders and photos" data-count={images.length}>
          {error && <p className="note warn" data-testid="dropbox-error">{error}</p>}
          {!entries && !error && <p className="muted">Loading…</p>}
          {entries && !entries.length && <p className="muted">This folder has no subfolders or images.</p>}
          {folders.map((f) => (
            <div key={f.id} className={`dbx-folder-row ${picked.has('dir:' + f.path) ? 'on' : ''}`} data-testid="dropbox-folder-row" data-name={f.name}>
              <input type="checkbox" className="dbx-folder-check" checked={picked.has('dir:' + f.path)} onChange={() => toggleDir(f.path)} aria-label={`Select folder ${f.name}`} data-testid="dropbox-folder-check" />
              <button className="dbx-row" data-testid="dropbox-folder" data-name={f.name} onClick={() => setPath(f.path)}>📁 <span>{f.name}</span></button>
              <FolderImport path={f.path} recursive={recursive} busy={busy} count={addCount} onStart={onClose} />
            </div>
          ))}
          <div ref={filesRef} aria-hidden="true" style={{ height: 0, flex: 'none' }} />
          {from > 0 && <div aria-hidden="true" style={{ height: from * ROW_H, flex: 'none' }} />}
          {images.slice(from, to).map((f, k) => fileRow(f, from + k))}
          {to < images.length && <div aria-hidden="true" style={{ height: (images.length - to) * ROW_H, flex: 'none' }} />}
        </div>
        <label className="check">
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} data-testid="dropbox-recursive" />
          <span>Include subfolders <small>Off by default so you don’t tag your whole Dropbox by accident. Applies to tagging a whole folder, ticked folders, the counts and Add by date — not to single photos you tick.</small></span>
        </label>
        <div className="row wrap">
          <button className="btn primary" data-testid="dropbox-process" disabled={busy || !!error || !entries}
            onClick={() => { void (nPicked ? lib.addDropboxSelection(chosen, chosenDirs, recursive) : lib.processDropboxFolder(path, recursive)); onClose() }}>
            {nPicked ? `Add selected (${nPicked})` : `Tag ${recursive ? 'this folder and subfolders' : `${fresh} new photo(s) here`}`}
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

/** "How many to add": 25 / 50 / 100 / 250 / 500 or a custom number (defaults to Photos per batch). */
function AddCount({ value, onChange, batch }: { value: number; onChange: (n: number) => void; batch: number }) {
  const [custom, setCustom] = useState(() => !PRESETS.includes(value))
  const [text, setText] = useState(String(value))
  return (
    <label className="dbx-opt" title={`How many photos “Add next batch” adds. They are still tagged, saved and checked ${batch} at a time (Settings → Dropbox → Photos per batch).`}>How many to add
      <select data-testid="add-count-select" value={custom ? 'custom' : String(value)} onChange={(e) => {
        if (e.target.value === 'custom') { setCustom(true); setText(String(value)) } else { setCustom(false); onChange(Number(e.target.value)) }
      }}>
        {PRESETS.map((n) => <option key={n} value={n}>{n}</option>)}
        <option value="custom">Custom…</option>
      </select>
      {custom && <input type="number" min={1} max={100000} inputMode="numeric" className="dbx-count-input" data-testid="add-count-custom" aria-label="Custom number of photos to add" value={text}
        onChange={(e) => { setText(e.target.value); const n = Math.round(Number(e.target.value)); if (Number.isFinite(n) && n >= 1) onChange(Math.min(100000, n)) }} />}
    </label>
  )
}

/** Add by date: from / to (or a quick year), using the dates Dropbox already lists — nothing is downloaded to filter. */
function DateRange({ path, recursive, busy, onStart }: { path: string; recursive: boolean; busy: boolean; onStart: () => void }) {
  const lib = useLibrary()
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<DropboxFile[] | null>(null)
  const [err, setErr] = useState('')
  const [fromD, setFrom] = useState('')
  const [toD, setTo] = useState('')
  useEffect(() => { setFiles(null); setErr(''); setFrom(''); setTo('') }, [path, recursive])
  useEffect(() => {
    if (!open || files) return
    let off = false
    lib.dropboxFolderFiles(path, recursive).then((f) => { if (!off) setFiles(f) }).catch((e: any) => { if (!off) setErr(e?.message || 'Could not list this folder') })
    return () => { off = true }
  }, [open, files, path, recursive, lib.dropboxFolderFiles])
  const inLibrary = useMemo(() => new Set(lib.photos.map((p) => p.dropbox?.id).filter(Boolean) as string[]), [lib.photos])
  const dated = useMemo(() => (files ?? []).map((f) => ({ f, t: dropboxFileDate(f) })), [files])
  const years = useMemo(() => [...new Set(dated.filter((x) => x.t).map((x) => new Date(x.t).getFullYear()))].sort((a, b) => b - a), [dated])
  const lo = fromD ? new Date(fromD + 'T00:00:00').getTime() : -Infinity
  const hi = toD ? new Date(toD + 'T23:59:59.999').getTime() : Infinity
  const active = !!(fromD || toD)
  const match = active ? dated.filter((x) => x.t && x.t >= lo && x.t <= hi).map((x) => x.f) : []
  const have = match.filter((f) => inLibrary.has(f.id)).length
  const toAdd = match.filter((f) => !inLibrary.has(f.id))
  const undated = dated.filter((x) => !x.t).length
  const yearOf = fromD && toD && fromD.endsWith('-01-01') && toD.endsWith('-12-31') && fromD.slice(0, 4) === toD.slice(0, 4) ? fromD.slice(0, 4) : ''
  return (
    <details className="dbx-date" data-testid="dbx-date-range" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Add by date</summary>
      {err && <p className="note warn">{err}</p>}
      {open && !files && !err && <p className="muted small">Reading dates from Dropbox…</p>}
      {files && <>
        <div className="row wrap dbx-date-fields">
          <label className="dbx-opt">Year
            <select data-testid="dbx-date-year" value={yearOf} onChange={(e) => { const y = e.target.value; if (y) { setFrom(`${y}-01-01`); setTo(`${y}-12-31`) } else { setFrom(''); setTo('') } }}>
              <option value="">—</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="dbx-opt">From <input type="date" data-testid="dbx-date-from" value={fromD} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="dbx-opt">To <input type="date" data-testid="dbx-date-to" value={toD} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <p className="small" data-testid="dbx-date-summary">{active
          ? `${fmtN(match.length)} match · ${fmtN(have)} already in library · ${fmtN(toAdd.length)} to add`
          : `Pick a year or dates. ${fmtN(files.length)} photo/video(s) ${recursive ? 'here and in subfolders' : 'in this folder'}.`}
          {undated > 0 && <span className="muted"> {fmtN(undated)} have no date and never match.</span>}</p>
        <p className="muted small">Uses the dates Dropbox lists: when the photo was taken if Dropbox knows it, otherwise when the file was last modified. Nothing is downloaded to filter.</p>
        <button className="btn small primary" data-testid="dbx-date-add" disabled={busy || !toAdd.length}
          onClick={() => { void lib.addDropboxSelection(toAdd); onStart() }}>Add {fmtN(toAdd.length)} from these dates</button>
      </>}
    </details>
  )
}

const fmtBytes = (n?: number) => (!n ? '' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)
function fmtDate(f: DropboxFile): string {
  const t = dropboxFileDate(f)
  return t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
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

const fmtN = (n: number) => n.toLocaleString('en-US')
// at most two folder listings at a time (metadata only — nothing is downloaded to count)
const countQ = { active: 0, wait: [] as (() => void)[] }
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (countQ.active >= 2) await new Promise<void>((r) => countQ.wait.push(r))
  countQ.active++
  try { return await fn() } finally { countQ.active--; countQ.wait.shift()?.() }
}
export function progressText(p: FolderProgress) {
  const scope = p.recursive ? 'incl. subfolders' : 'this folder only'
  if (!p.total) return `No photos or videos (${scope})`
  const skip = p.skipped ? ` · ${fmtN(p.skipped)} skipped` : ''
  return p.remaining <= 0 ? `All in library${skip} (${scope})` : `${fmtN(p.inLibrary)} of ${fmtN(p.total)} in library${skip} (${scope})`
}
/** "1,200 of 2,000 in library" plus one-click Add next batch / Add all remaining for one folder. */
function FolderImport({ path, recursive, busy, count, onStart }: { path: string; recursive: boolean; busy: boolean; count: number; onStart: () => void }) {
  const lib = useLibrary()
  const [p, setP] = useState<FolderProgress | null>(null)
  const [err, setErr] = useState('')
  const batch = Math.max(10, Math.min(500, lib.settings.dropboxBatchSize || 100))
  const n = Math.max(1, count)
  const orderName = { name: 'name order', oldest: 'oldest first', newest: 'newest first' }[lib.settings.dropboxAddOrder ?? 'name']
  useEffect(() => {
    let off = false
    setErr('')
    slot(() => lib.dropboxFolderProgress(path, recursive)).then((x) => { if (!off) setP(x) }).catch((e: any) => { if (!off) setErr(e?.message || 'could not count') })
    return () => { off = true }
  }, [path, recursive, lib.photos.length, lib.dropboxFolderProgress])
  if (err) return <small className="muted dbx-progress" data-testid="folder-progress">Couldn't count: {err}</small>
  if (!p) return <small className="muted dbx-progress" data-testid="folder-progress" data-loading="1">Counting…</small>
  return (
    <span className="dbx-progress-wrap">
      <small className={`dbx-progress ${p.remaining <= 0 && p.total ? 'all' : ''}`} data-testid="folder-progress" data-in={p.inLibrary} data-total={p.total} data-skipped={p.skipped}>{progressText(p)}</small>
      {p.remaining > 0 && <>
        <button className="btn small" data-testid="folder-next-batch" disabled={busy} title={`Adds the next ${n} photos that aren't in your library yet (${orderName}); tagged, saved and checked ${batch} at a time`}
          onClick={() => { void lib.addNextDropboxBatch(path, recursive, n); onStart() }}>Add next batch ({fmtN(Math.min(n, p.remaining))})</button>
        <button className="btn small" data-testid="folder-add-remaining" disabled={busy} title={`Adds all ${fmtN(p.remaining)} remaining photos (${orderName}), ${batch} per batch`}
          onClick={() => { void lib.addAllRemainingDropbox(path, recursive); onStart() }}>Add all remaining ({fmtN(p.remaining)})</button>
      </>}
    </span>
  )
}
