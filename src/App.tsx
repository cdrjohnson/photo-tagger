import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Detail } from './components/Detail'
import { SettingsDialog } from './components/SettingsDialog'
import { TagInput } from './components/TagInput'
import { PeopleView } from './components/PeopleView'
import { DupeReview } from './components/DupeReview'
import { usePeople } from './people'
import { filterPhotos, tagStats, photoTime } from './filter'
import { useInView, useTheme, useThumb } from './hooks'
import { useLibrary } from './store'
import { EMPTY_FILTERS, type Filters, type Photo, type QualityFilter, type SortKey } from './types'

const FEW = 16 // tag chips shown before "All tags"

export default function App() {
  const lib = useLibrary()
  const ppl = usePeople()
  const [view, setView] = useState<'photos' | 'people'>('photos')
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [settings, setSettings] = useState<{ tab?: 'general' | 'dropbox' | 'vocab' | 'data'; note?: string } | null>(null)
  const [addMenu, setAddMenu] = useState(false)
  const [allTags, setAllTags] = useState(false)
  const [moreFilters, setMoreFilters] = useState(false)
  const [bulk, setBulk] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [cancelDropboxConfirm, setCancelDropboxConfirm] = useState(false)
  useEffect(() => {
    if (cancelDropboxConfirm && !lib.job?.cancellable) setCancelDropboxConfirm(false)
  }, [cancelDropboxConfirm, lib.job?.cancellable])
  const [theme, cycleTheme] = useTheme()
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const lastClicked = useRef<number | null>(null)
  const headRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = headRef.current
    if (!el) return
    const set = () => document.documentElement.style.setProperty('--top-h', `${el.offsetHeight}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const filtered = useMemo(() => filterPhotos(lib.photos, filters), [lib.photos, filters])
  const stats = useMemo(() => tagStats(lib.photos, filters), [lib.photos, filters])
  const everyTag = useMemo(() => [...new Set(lib.photos.flatMap((p) => p.tags.map((t) => t.name)))].sort(), [lib.photos])
  const visibleStats = allTags ? stats : stats.filter((s, i) => i < FEW || filters.tags.includes(s.name))
  const hasFilters = filters.tags.length > 0 || filters.query || filters.from || filters.to || filters.quality !== 'any'
  const advancedCount = [filters.from, filters.to, filters.quality !== 'any' ? 'q' : ''].filter(Boolean).length

  // ----- drag & drop -----
  useEffect(() => {
    let depth = 0
    const has = (e: DragEvent) => e.dataTransfer?.types?.includes('Files')
    const enter = (e: DragEvent) => { if (has(e)) { depth++; setDragging(true) } }
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false) }
    const over = (e: DragEvent) => { if (has(e)) e.preventDefault() }
    const drop = (e: DragEvent) => {
      if (!has(e)) return
      e.preventDefault(); depth = 0; setDragging(false)
      void lib.addFiles([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over); window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over); window.removeEventListener('drop', drop)
    }
  }, [lib])

  // paste images (desktop)
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (files.length) void lib.addFiles(files)
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [lib])

  useEffect(() => { setSel((s) => { const ids = new Set(lib.photos.map((p) => p.id)); const n = new Set([...s].filter((x) => ids.has(x))); return n.size === s.size ? s : n }) }, [lib.photos])
  useEffect(() => { if (!addMenu) return; const c = () => setAddMenu(false); window.addEventListener('click', c); return () => window.removeEventListener('click', c) }, [addMenu])

  const toggleTag = (name: string) =>
    setFilters((f) => ({ ...f, tags: f.tags.includes(name) ? f.tags.filter((t) => t !== name) : [...f.tags, name] }))

  const inSelection = selectMode || sel.size > 0
  const onTile = useCallback((i: number, id: string, e: { shiftKey: boolean }) => {
    if (inSelection) {
      setSel((s) => {
        const n = new Set(s)
        if (e.shiftKey && lastClicked.current != null) {
          const [a, b] = [lastClicked.current, i].sort((x, y) => x - y)
          for (let k = a; k <= b; k++) n.add(filtered[k].id)
        } else if (n.has(id)) n.delete(id)
        else n.add(id)
        return n
      })
      lastClicked.current = i
    } else setOpen(i)
  }, [inSelection, filtered])
  const onLong = useCallback((i: number, id: string) => { setSelectMode(true); setSel((s) => new Set(s).add(id)); lastClicked.current = i }, [])
  const onCheck = useCallback((i: number, id: string) => { setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n }); lastClicked.current = i }, [])

  const exitSelect = () => { setSel(new Set()); setSelectMode(false) }
  const selIds = [...sel]
  const selPhotos = lib.photos.filter((p) => sel.has(p.id))
  const selTags = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of selPhotos) for (const t of p.tags) m.set(t.name, (m.get(t.name) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [selPhotos])

  const pick = (ref: React.RefObject<HTMLInputElement | null>) => { setAddMenu(false); ref.current?.click() }
  const onFiles = (e: React.ChangeEvent<HTMLInputElement>) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; void lib.addFiles(f) }
  const doDropbox = async () => {
    setAddMenu(false)
    const r = await lib.importFromDropbox()
    if (r === 'no-key') setSettings({ tab: 'dropbox', note: 'Add your Dropbox app key to import from Dropbox. It takes about two minutes – steps below.' })
  }

  const j = lib.job
  const m = lib.model
  const modelBusy = m.state === 'loading'
  const pct = m.total ? Math.min(100, Math.round((m.loaded / m.total) * 100)) : 0

  return (
    <div className="app">
      <header className="top" ref={headRef}>
        <div className="brand"><img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width="28" height="28" /><span>Photo Tagger</span></div>
        <div className="seg view-tabs" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'photos'} className={view === 'photos' ? 'on' : ''} data-testid="view-photos" onClick={() => setView('photos')}>Photos</button>
          <button role="tab" aria-selected={view === 'people'} className={view === 'people' ? 'on' : ''} data-testid="view-people" onClick={() => setView('people')}>
            People{ppl.suggestions.size ? <span className="dot-count">{ppl.suggestions.size}</span> : null}
          </button>
        </div>
        <div className="search">
          <input type="search" data-testid="search" placeholder="Search names, tags, cameras…" aria-label="Search photos" value={filters.query} onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))} />
        </div>
        <div className="actions">
          <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
            <button className="btn primary" data-testid="add-btn" aria-haspopup="menu" aria-expanded={addMenu} onClick={() => setAddMenu((v) => !v)}>＋ <span className="hide-sm">Add photos</span></button>
            {addMenu && (
              <div className="menu" role="menu">
                <button role="menuitem" data-testid="add-photos" onClick={() => pick(fileRef)}>📁 Choose photos<small>Gallery, camera roll or files</small></button>
                <button role="menuitem" data-testid="add-camera" onClick={() => pick(camRef)}>📷 Take a photo<small>Use the camera</small></button>
                <button role="menuitem" className="desktop-only" data-testid="add-folder" onClick={() => pick(dirRef)}>🗂 Add a folder<small>All images inside</small></button>
                <button role="menuitem" data-testid="add-dropbox" onClick={doDropbox}>📦 From Dropbox<small>{lib.dropboxKey ? 'Pick files in Dropbox' : 'Needs an app key'}</small></button>
              </div>
            )}
          </div>
          <button className={`btn ${inSelection ? 'on' : ''}`} data-testid="select-mode" onClick={() => (inSelection ? exitSelect() : setSelectMode(true))} aria-pressed={inSelection}>☑ <span className="hide-sm">Select</span></button>
          <button className="btn icon" data-testid="theme" onClick={cycleTheme} aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`}>{theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '🌓'}</button>
          <button className="btn icon" data-testid="open-settings" onClick={() => setSettings({})} aria-label="Settings" title="Settings">⚙️</button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden data-testid="file-input" onChange={onFiles} />
        <input ref={camRef} type="file" accept="image/*" capture="environment" hidden data-testid="camera-input" onChange={onFiles} />
        <input ref={dirRef} type="file" hidden multiple {...({ webkitdirectory: '', directory: '' } as object)} data-testid="folder-input" onChange={onFiles} />
      </header>

      {(j || m.state === 'loading' || lib.pendingCount > 0) && (
        <div className="banner" role="status" data-testid="banner">
          {modelBusy && (
            <div className="bar-line">
              <span>{m.phase === 'text' ? 'Downloading text model (for custom labels, once)' : 'Downloading the tagging model (first time only)'}… {m.total ? `${pct}% of ${(m.total / 1e6).toFixed(0)} MB` : ''}</span>
              <div className="bar"><i style={{ width: `${pct}%` }} /></div>
            </div>
          )}
          {j && (
            <div className="bar-line">
              <span data-testid="job-label">
                {j.total === 0
                  ? (j.label || 'Working…')
                  : `${j.done >= j.total ? 'Done' : j.label || 'Working…'} · ${Math.min(j.done, j.total)}/${j.total}${j.failed ? ` · ${j.failed} failed` : ''}`
                }
              </span>
              {j.total > 0 && <div className="bar"><i style={{ width: `${Math.min(100, (j.done / j.total) * 100)}%` }} /></div>}
              {j.cancellable && (
                <button type="button" className="btn small" data-testid="job-cancel" aria-label="Cancel remaining Dropbox downloads"
                  onClick={() => setCancelDropboxConfirm(true)}>Cancel</button>
              )}
            </div>
          )}
          {!j && !modelBusy && lib.pendingCount > 0 && (
            <div className="bar-line">
              <span>{lib.pendingCount} photo(s) not tagged yet.</span>
              <button className="btn small" data-testid="retry-tagging" onClick={() => void lib.retryPending()}>Retry tagging</button>
            </div>
          )}
        </div>
      )}

      {view === 'photos' && lib.photos.length > 0 && (
        <section className="filters" aria-label="Filters">
          <div className="chip-row">
            <div className={`chips ${allTags ? 'wrap' : 'scroll'}`} data-testid="chip-bar">
              {visibleStats.map((s) => (
                <button key={s.name} className={`chip src-${s.source} ${filters.tags.includes(s.name) ? 'on' : ''}`} aria-pressed={filters.tags.includes(s.name)} data-testid="tag-chip" data-tag={s.name} onClick={() => toggleTag(s.name)}>
                  {s.name}<small>{s.count}</small>
                </button>
              ))}
            </div>
            {stats.length > FEW && <button className="btn small" data-testid="all-tags" onClick={() => setAllTags((v) => !v)}>{allTags ? 'Fewer' : `All ${stats.length}`}</button>}
          </div>
          <div className="controls">
            <div className="seg" role="group" aria-label="Match mode">
              <button className={filters.mode === 'and' ? 'on' : ''} aria-pressed={filters.mode === 'and'} data-testid="mode-and" onClick={() => setFilters((f) => ({ ...f, mode: 'and' }))} title="Photos must have all selected tags">AND</button>
              <button className={filters.mode === 'or' ? 'on' : ''} aria-pressed={filters.mode === 'or'} data-testid="mode-or" onClick={() => setFilters((f) => ({ ...f, mode: 'or' }))} title="Photos with any selected tag">OR</button>
            </div>
            <button className="btn small show-sm" data-testid="more-filters" onClick={() => setMoreFilters((v) => !v)}>Filters{advancedCount ? ` (${advancedCount})` : ''} ▾</button>
            <div className={`advanced ${moreFilters ? 'open' : ''}`}>
              <label>Quality
                <select data-testid="quality" value={filters.quality} onChange={(e) => setFilters((f) => ({ ...f, quality: e.target.value as QualityFilter }))}>
                  <option value="any">Any</option><option value="good">Good only</option><option value="blurry">Blurry</option><option value="dark">Dark</option><option value="bright">Bright</option>
                </select>
              </label>
              <label>From <input type="date" data-testid="date-from" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} /></label>
              <label>To <input type="date" data-testid="date-to" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} /></label>
              <label>Sort
                <select data-testid="sort" value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as SortKey }))}>
                  <option value="taken-desc">Newest first</option><option value="taken-asc">Oldest first</option><option value="added-desc">Recently added</option><option value="name-asc">Name</option>
                </select>
              </label>
            </div>
            <span className="spacer" />
            <span className="count" data-testid="count" aria-live="polite">{filtered.length === lib.photos.length ? `${lib.photos.length} photos` : `${filtered.length} of ${lib.photos.length}`}</span>
            {hasFilters && <button className="btn small" data-testid="clear-filters" onClick={() => setFilters((f) => ({ ...EMPTY_FILTERS, mode: f.mode, sort: f.sort }))}>Clear</button>}
          </div>
        </section>
      )}

      <main>
        {view === 'people' ? <PeopleView onShowPhotos={(name) => { setFilters({ ...EMPTY_FILTERS, tags: [name.trim().toLowerCase().replace(/\s+/g, ' ')] }); setView('photos') }} />
          : !lib.ready ? <div className="center"><div className="spinner" /></div>
          : lib.isDesktop && !lib.libraryPath ? (
            <div className="empty" data-testid="choose-library">
              <div className="empty-art" aria-hidden>📁</div>
              <h1>Choose a library folder</h1>
              <p>Photo Tagger Desktop keeps your originals on disk in a folder you choose. Thumbnails, tags, faces and settings live in a hidden <code>.photo-tagger</code> subfolder — nothing is uploaded.</p>
              <button className="btn primary big" data-testid="pick-library" onClick={() => void lib.chooseLibraryFolder()}>Choose library folder…</button>
              <p className="muted small">You can change this later in Settings → Data. Existing browser libraries are not migrated automatically — re-import photos into this folder.</p>
            </div>
          )
          : lib.photos.length === 0 ? (
            <div className="empty" data-testid="empty">
              <div className="empty-art" aria-hidden>🖼️</div>
              <h1>Tag and find your photos — privately</h1>
              <p>{lib.isDesktop
                ? <>Add photos from this device or Dropbox. They are copied into your library folder and tagged on-device. Originals stay on disk.</>
                : <>Add photos from this device or Dropbox. A small AI model running <b>in your browser</b> labels what’s in each one. Nothing is uploaded anywhere.</>}</p>
              <div className="row center wrap">
                <button className="btn primary big" data-testid="empty-add" onClick={() => fileRef.current?.click()}>Choose photos</button>
                <button className="btn big touch-only" onClick={() => camRef.current?.click()}>Take a photo</button>
                <button className="btn big" onClick={doDropbox}>From Dropbox</button>
              </div>
              <p className="muted desktop-only">…or drag and drop images anywhere on this page.</p>
              <p className="muted small">The first import downloads the ≈64&nbsp;MB tagging model once; after that it works offline.</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty" data-testid="no-results">
              <h2>No photos match</h2>
              <p className="muted">Try removing a tag, switching AND → OR, or widening the dates.</p>
              <button className="btn" onClick={() => setFilters((f) => ({ ...EMPTY_FILTERS, mode: f.mode, sort: f.sort }))}>Clear filters</button>
            </div>
          ) : (
            <PhotoGrid filtered={filtered} sel={sel} inSelection={inSelection} onTile={onTile} onLong={onLong} onCheck={onCheck} />
          )}
      </main>

      {view === 'photos' && inSelection && (
        <div className="selbar" data-testid="selbar">
          <button className="btn icon" onClick={exitSelect} aria-label="Cancel selection" data-testid="sel-cancel">✕</button>
          <b data-testid="sel-count">{sel.size} selected</b>
          <button className="btn small" data-testid="sel-all" onClick={() => setSel(new Set(filtered.map((p) => p.id)))}>All {filtered.length}</button>
          <span className="spacer" />
          <button className="btn primary" disabled={!sel.size} data-testid="bulk-tag" onClick={() => setBulk(true)}>Tags…</button>
          <button className="btn" disabled={!sel.size} data-testid="sel-export" onClick={() => lib.exportData('json', selIds)}>Export tags</button>
          <button className="btn" disabled={!sel.size} data-testid="sel-save" onClick={() => void (lib.folderSupported ? lib.savePhotosToDisk(selIds) : lib.downloadPhotosZip(selIds))}>{lib.folderSupported ? 'Save to folder…' : 'Download zip…'}</button>
          <button className="btn danger" disabled={!sel.size} data-testid="sel-delete" onClick={async () => { if (confirm(`Delete ${sel.size} photo(s) from this app? Originals elsewhere are not affected.`)) { await lib.deletePhotos(selIds); exitSelect() } }}>Delete</button>
        </div>
      )}

      {bulk && (
        <div className="modal sheet" role="dialog" aria-modal="true" aria-label="Edit tags" data-testid="bulk">
          <div className="sheet-card">
            <div className="settings-head"><h2>Tags for {sel.size} photo(s)</h2><button className="btn icon" onClick={() => setBulk(false)} aria-label="Close" data-testid="bulk-close">✕</button></div>
            <TagInput autoFocus suggestions={everyTag} testId="bulk-input" placeholder="Add tags (comma separated)" onAdd={(n) => lib.addTags(selIds, n)} />
            <p className="muted small">Tags on the selection (tap × to remove from all selected):</p>
            <div className="chips wrap">
              {selTags.map(([n, c]) => (
                <span key={n} className="chip static" data-testid="bulk-tag-chip" data-tag={n}>{n}<small>{c}/{sel.size}</small>
                  <button aria-label={`Remove ${n} from selection`} data-testid="bulk-remove" onClick={() => (ppl.isPersonTag(n) ? ppl.rejectOnPhotos(selIds, n) : lib.removeTags(selIds, [n]))}>×</button></span>
              ))}
              {!selTags.length && <span className="muted">None yet</span>}
            </div>
          </div>
        </div>
      )}

      {open != null && filtered.length > 0 && (
        <Detail list={filtered} index={Math.min(open, filtered.length - 1)} onIndex={setOpen} onClose={() => setOpen(null)} allTags={everyTag} />
      )}
      {settings && <SettingsDialog initialTab={settings.tab} note={settings.note} onClose={() => setSettings(null)} />}
      
      {cancelDropboxConfirm && (
        <div className="modal sheet" role="dialog" aria-modal="true" aria-labelledby="cancel-dropbox-title" data-testid="cancel-dropbox-confirm">
          <div className="sheet-card">
            <div className="settings-head">
              <h2 id="cancel-dropbox-title">Cancel Dropbox download?</h2>
              <button className="btn icon" aria-label="Close" data-testid="cancel-dropbox-dismiss" onClick={() => setCancelDropboxConfirm(false)}>✕</button>
            </div>
            <p>Remaining downloads will stop. Photos <b>already added</b> to your library stay there and keep tagging if needed. In-progress downloads will not be kept.</p>
            <div className="row wrap" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" data-testid="cancel-dropbox-keep" onClick={() => setCancelDropboxConfirm(false)}>Keep downloading</button>
              <button type="button" className="btn danger" data-testid="cancel-dropbox-confirm-btn" onClick={() => {
                setCancelDropboxConfirm(false)
                lib.cancelDropboxDownload()
              }}>Cancel download</button>
            </div>
          </div>
        </div>
      )}

      <DupeReview />
      {dragging && <div className="dropzone" data-testid="dropzone"><div>Drop photos to add them</div></div>}

      <div className="toasts" aria-live="polite">
        {lib.toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  )
}


const TILE_MIN = 170
const PhotoGrid = memo(function PhotoGrid({ filtered, sel, inSelection, onTile, onLong, onCheck }: {
  filtered: Photo[]
  sel: Set<string>; inSelection: boolean
  onTile: (i: number, id: string, e: { shiftKey: boolean }) => void
  onLong: (i: number, id: string) => void
  onCheck: (i: number, id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 80 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const cols = Math.max(1, Math.floor(el.clientWidth / (TILE_MIN + 8)))
      const rowH = (el.clientWidth / cols) + 8
      const scrollParent = el.closest('main') || document.documentElement
      const top = scrollParent === document.documentElement ? window.scrollY : (scrollParent as HTMLElement).scrollTop
      const viewH = scrollParent === document.documentElement ? window.innerHeight : (scrollParent as HTMLElement).clientHeight
      const startRow = Math.max(0, Math.floor(top / rowH) - 2)
      const endRow = Math.ceil((top + viewH) / rowH) + 2
      setRange({ start: startRow * cols, end: Math.min(filtered.length, endRow * cols) })
    }
    update()
    const scrollParent = el.closest('main') || window
    scrollParent.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      scrollParent.removeEventListener('scroll', update as any)
      window.removeEventListener('resize', update)
    }
  }, [filtered.length])
  // Small libraries: render all (keeps e2e simple)
  const virtual = filtered.length > 120
  const start = virtual ? range.start : 0
  const end = virtual ? range.end : filtered.length
  const topPad = virtual && start > 0 ? Math.floor(start / Math.max(1, Math.floor((ref.current?.clientWidth || 800) / (TILE_MIN + 8)))) * ((ref.current?.clientWidth || 800) / Math.max(1, Math.floor((ref.current?.clientWidth || 800) / (TILE_MIN + 8))) + 8) : 0
  return (
    <div className="grid" data-testid="grid" ref={ref} style={virtual ? { paddingTop: topPad } : undefined}>
      {filtered.slice(start, end).map((p, j) => {
        const i = start + j
        return <Tile key={p.id} p={p} i={i} selected={sel.has(p.id)} selecting={inSelection} onTile={onTile} onLong={onLong} onCheck={onCheck} />
      })}
    </div>
  )
})

const Tile = memo(function Tile({ p, i, selected, selecting, onTile, onLong, onCheck }: {
  p: Photo; i: number; selected: boolean; selecting: boolean
  onTile: (i: number, id: string, e: { shiftKey: boolean }) => void
  onLong: (i: number, id: string) => void
  onCheck: (i: number, id: string) => void
}) {
  const [ref, seen] = useInView<HTMLDivElement>()
  const url = useThumb(p.id, seen)
  const timer = useRef<number>(0)
  const fired = useRef(false)
  const start = () => { fired.current = false; timer.current = window.setTimeout(() => { fired.current = true; onLong(i, p.id) }, 550) }
  const stop = () => clearTimeout(timer.current)
  const shown = p.tags.filter((t) => t.source === 'auto' || t.source === 'manual').slice(0, 2)
  const warn = [p.quality.blurry && 'blurry', p.quality.dark && 'dark', p.quality.bright && 'bright'].filter(Boolean) as string[]
  return (
    <div
      ref={ref}
      className={`tile ${selected ? 'sel' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${p.name}${selected ? ', selected' : ''}`}
      data-testid="photo-tile"
      data-name={p.name}
      data-status={p.status}
      data-duplicate={p.duplicateOf ? "1" : "0"}
      data-tags={p.tags.map((t) => t.name).join('|')}
      onClick={(e) => { if (fired.current) { fired.current = false; return } onTile(i, p.id, e) }}
      onKeyDown={(e) => { if (e.key === 'Enter') onTile(i, p.id, e); if (e.key === ' ') { e.preventDefault(); onCheck(i, p.id) } }}
      onTouchStart={start} onTouchEnd={stop} onTouchMove={stop} onTouchCancel={stop}
      onContextMenu={(e) => { if ('ontouchstart' in window) e.preventDefault() }}
    >
      {url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <div className="ph" />}
      <button className={`check-box ${selecting ? 'show' : ''}`} aria-label={selected ? 'Deselect' : 'Select'} aria-pressed={selected} data-testid="tile-check" onClick={(e) => { e.stopPropagation(); onCheck(i, p.id) }}>{selected ? '✓' : ''}</button>
      {p.status === 'pending' && <span className="badge pend" title="Tagging…">tagging…</span>}
      {p.duplicateOf && <span className="badge dupe" data-testid="dupe-badge" title="Marked as a duplicate">duplicate</span>}
      {warn.length > 0 && <span className="badge warn" title={warn.join(', ')}>{warn[0]}</span>}
      <div className="cap">{shown.map((t) => <span key={t.name}>{t.name}</span>)}</div>
      <span className="sr-only">{new Date(photoTime(p)).toDateString()}</span>
    </div>
  )
})

