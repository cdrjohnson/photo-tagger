import { useEffect, useMemo, useRef, useState } from 'react'
import { META_TAGS, addTag, looseTagKey, matchTags, normTag, removeTag, resolveTagName } from '../tags'
import { DEFAULT_LABELS } from '../labels'
import { DESKTOP_REDIRECT_URI, DROPBOX_SCOPES, ENV_DROPBOX_KEY, WEB_REDIRECT_URI, redirectUri } from '../dropbox'
import { useLibrary } from '../store'
import { usePeople } from '../people'

type Tab = 'general' | 'dropbox' | 'vocab' | 'data'
const fmtMB = (n: number) => `${(n / 1e6).toFixed(0)} MB`

export function SettingsDialog({ initialTab = 'general', note, onClose }: { initialTab?: Tab; note?: string; onClose: () => void }) {
  const lib = useLibrary()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [dirty, setDirty] = useState(false)
  const close = () => { onClose(); if (dirty) void lib.retagAll() }

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  return (
    <div className="modal settings" role="dialog" aria-modal="true" aria-label="Settings" data-testid="settings">
      <div className="settings-card">
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="btn icon" onClick={close} aria-label="Close settings" data-testid="settings-close">✕</button>
        </div>
        <div className="tabs" role="tablist">
          {([['general', 'General'], ['dropbox', 'Dropbox'], ['vocab', 'Tags'], ['data', 'Data']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} data-testid={`tab-${k}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="settings-body">
          {note && <p className="note warn" data-testid="settings-note">{note}</p>}
          {tab === 'general' && <General onDirty={() => setDirty(true)} />}
          {tab === 'dropbox' && <DropboxTab />}
          {tab === 'vocab' && <Vocab onDirty={() => setDirty(true)} />}
          {tab === 'data' && <Data />}
        </div>
      </div>
    </div>
  )
}

function Slider({ label, hint, value, min, max, step, onChange, testId }: {
  label: string; hint: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; testId?: string
}) {
  return (
    <label className="field">
      <span>{label} <b>{value}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} data-testid={testId} onChange={(e) => onChange(Number(e.target.value))} />
      <small>{hint}</small>
    </label>
  )
}

function General({ onDirty }: { onDirty: () => void }) {
  const { settings: s, saveSettings, model, preloadModel, isDesktop } = useLibrary()
  const [est, setEst] = useState('')
  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => setEst(`${fmtMB(e.usage ?? 0)} used of ${fmtMB(e.quota ?? 0)} available to this app`)).catch(() => {})
  }, [])
  const set = (p: Partial<typeof s>) => { void saveSettings(p); onDirty() }
  return (
    <>
      <h3>Tagging</h3>
      <Slider label="Confidence needed for a tag" hint="Lower = more tags per photo (and more mistakes). Higher = fewer, safer tags." value={s.threshold} min={0.03} max={0.5} step={0.01} onChange={(v) => set({ threshold: v })} testId="set-threshold" />
      <Slider label="Maximum auto-tags per photo" hint="Related tags (for example dog → pets, animals) are added on top of this." value={s.maxTags} min={1} max={8} step={1} onChange={(v) => set({ maxTags: v })} />
      <h3>Quality checks</h3>
      <Slider label="Blur threshold" hint="Photos with sharpness below this get the “blurry” tag. Raise it to flag more photos." value={s.blurThreshold} min={5} max={400} step={5} onChange={(v) => set({ blurThreshold: v })} />
      <Slider label="Dark threshold" hint="Average brightness (0–255) below this gets “dark”." value={s.darkThreshold} min={10} max={120} step={5} onChange={(v) => set({ darkThreshold: v })} />
      <Slider label="Bright threshold" hint="Average brightness above this gets “bright”." value={s.brightThreshold} min={150} max={250} step={5} onChange={(v) => set({ brightThreshold: v })} />
      <p className="muted">Changes are applied to your library when you close settings.</p>
      <h3>Storage</h3>
      {isDesktop ? (
        <p className="muted">Desktop mode always keeps the original file in your library folder. Thumbnails and 2048&nbsp;px views are cached under <code>.photo-tagger/</code>.</p>
      ) : (
        <label className="check">
          <input type="checkbox" checked={s.keepOriginals} onChange={(e) => saveSettings({ keepOriginals: e.target.checked })} data-testid="set-keep-originals" />
          <span>Keep full-size originals <small>Off (default): each photo is stored as a 2048&nbsp;px copy plus a thumbnail, which saves a lot of space. Applies to photos you add from now on.</small></span>
        </label>
      )}
      {est && !isDesktop && <p className="muted">{est}</p>}
      <h3>Model</h3>
      <p className="muted">
        CLIP ViT-B/32 (4-bit, ≈64&nbsp;MB) runs inside your browser. It downloads once and is then cached. Status:{' '}
        <b data-testid="model-state">{model.state === 'ready' ? 'loaded' : model.state === 'loading' ? 'loading…' : model.state === 'error' ? `failed (${model.error})` : 'not loaded yet'}</b>
      </p>
      <div className="row wrap">
        <button className="btn" onClick={() => void preloadModel()} disabled={model.state === 'loading' || model.state === 'ready'}>Download model now</button>
      </div>
      <label className="field">
        <span>Model host</span>
        <input type="url" value={s.modelHost} onChange={(e) => saveSettings({ modelHost: e.target.value })} />
        <small>Where model files are fetched from. Default is Hugging Face; point this at your own mirror if you like. Reload the app after changing it.</small>
      </label>
    </>
  )
}

function DropboxTab() {
  const { settings, saveSettings, dropboxKey, dropbox, connectDropbox, disconnectDropbox, isDesktop } = useLibrary()
  const [v, setV] = useState(settings.dropboxAppKey)
  const redirects = isDesktop ? [DESKTOP_REDIRECT_URI] : [...new Set([redirectUri(), WEB_REDIRECT_URI])]
  return (
    <>
      <h3>Dropbox as your library</h3>
      <p>
        Connect your Dropbox once, then browse your folders inside Photo Tagger and tag them. Each photo is downloaded <b>into memory only</b> to run tagging and
        face recognition, then discarded. Tags and face names are added to each photo as <b>Dropbox tags</b> (searchable in Dropbox), and all metadata is <b>written to your Dropbox</b> (a hidden <code>/.photo-tagger</code> folder, one small file per photo).
        Photo Tagger keeps <b>nothing about your Dropbox photos on this device</b> — only the app key, your Dropbox sign-in and app settings. Your photos are never changed, moved or deleted.
      </p>
      <ol className="steps">
        <li>Open <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noreferrer noopener">dropbox.com/developers/apps</a> and pick the app you already created
          (or create one: Scoped access → <b>Full Dropbox</b>). With <b>App folder</b> access you can only browse <code>/Apps/&lt;your app&gt;</code>; choose Full Dropbox to browse your real photo folders.</li>
        <li>On the <b>Permissions</b> tab, tick {DROPBOX_SCOPES.map((sc, i) => <span key={sc}>{i ? ', ' : ''}<code data-testid="dropbox-scope">{sc}</code></span>)} and click <b>Submit</b>. <code>files.content.write</code> is used only to save Photo Tagger’s metadata files in <code>/.photo-tagger</code>; <code>files.metadata.write</code> adds the tags to each photo as Dropbox tags so you can search them in Dropbox. Already connected? After ticking a new permission, click <b>Disconnect</b> and <b>Connect Dropbox</b> again.</li>
        <li>On the <b>Settings</b> tab under OAuth 2, set <b>Allow public clients (Implicit Grant &amp; PKCE)</b> to <b>Allow</b>, then add {redirects.length > 1 ? 'these Redirect URIs' : 'this Redirect URI'} exactly (press Add after each):
          {redirects.map((r) => <div key={r}><code data-testid="redirect-uri">{r}</code></div>)}
          {!isDesktop && <small> The Windows app uses <code>{DESKTOP_REDIRECT_URI}</code> — add it too if you use both.</small>}</li>
        <li>Copy the <b>App key</b> (never the App secret) and paste it below, then click <b>Connect Dropbox</b>.</li>
      </ol>
      <label className="field">
        <span>App key</span>
        <input data-testid="dropbox-key" value={v} placeholder={ENV_DROPBOX_KEY ? '(using the build-time key)' : 'e.g. a1b2c3d4e5f6g7h'} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setV(e.target.value.trim())} />
      </label>
      <div className="row wrap">
        <button className="btn" data-testid="dropbox-save" onClick={() => saveSettings({ dropboxAppKey: v })}>Save key</button>
        {dropbox.connected
          ? <>
              <span className="muted" data-testid="dropbox-status">Connected{dropbox.account ? ` as ${dropbox.account}` : ''}</span>
              <button className="btn danger" data-testid="dropbox-disconnect" onClick={() => void disconnectDropbox()}>Disconnect</button>
            </>
          : <>
              <button className="btn primary" data-testid="dropbox-connect" disabled={!dropboxKey || dropbox.connecting}
                onClick={async () => { if (v !== settings.dropboxAppKey) await saveSettings({ dropboxAppKey: v }); await connectDropbox() }}>
                {dropbox.connecting ? (isDesktop ? 'Finish in your browser…' : 'Connecting…') : 'Connect Dropbox'}</button>
              <span className="muted" data-testid="dropbox-status">{dropboxKey ? 'Not connected.' : 'No key set yet.'}</span>
            </>}
      </div>
      <p className="muted"><small>Disconnect forgets the sign-in on this device; your tags stay in Dropbox and come back when you connect again. Photo Tagger never ships a key.</small></p>
    </>
  )
}

function Vocab({ onDirty }: { onDirty: () => void }) {
  const lib = useLibrary()
  const [label, setLabel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const groups = new Map<string, typeof DEFAULT_LABELS>()
  for (const l of DEFAULT_LABELS) if (!q || l.label.includes(q.toLowerCase())) groups.set(l.group, [...(groups.get(l.group) ?? []), l])
  const off = new Set(lib.settings.disabledLabels)
  const offMeta = new Set(lib.settings.disabledMetaTags ?? [])
  const meta = META_TAGS.filter((l) => !q || l.label.toLowerCase().includes(q.toLowerCase()))
  return (
    <>
      <LibraryTags onDirty={onDirty} />
      <section className="tag-card detect" data-testid="detection-card">
      <div className="eyebrow">What the app can find</div>
      <h3>Detection list</h3>
      <p className="muted small">
        Tags Photo Tagger can look for automatically — not the tags already on your photos. Turn one off if you never want it detected, or add your own (for example “bike race”, “my dog Rex”,
        “whiteboard notes”). The first custom detection tag downloads a text model (≈72&nbsp;MB, once).
      </p>
      <form className="add-label" onSubmit={async (e) => {
        e.preventDefault()
        if (!label.trim()) return
        setBusy(true); onDirty()
        await lib.addCustomLabel(label, prompt)
        setBusy(false); setLabel(''); setPrompt('')
      }}>
        <input data-testid="custom-label" placeholder="New detection tag, e.g. lighthouse" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input data-testid="custom-prompt" placeholder="Optional description, e.g. a photo of a lighthouse by the sea" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button className="btn primary" data-testid="custom-add" disabled={busy || !label.trim()}>{busy ? 'Adding…' : 'Add a detection tag'}</button>
      </form>
      {lib.custom.length > 0 && (
        <div className="vocab-group">
          <h4>Your tags</h4>
          <div className="chips">
            {lib.custom.map((c) => (
              <span key={c.id} className="chip src-manual static" data-testid="custom-chip">{c.label}
                <button aria-label={`Delete label ${c.label}`} onClick={() => { void lib.removeCustomLabel(c.id); onDirty() }}>×</button>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="action-help" data-testid="retag-all-group">
        <button className="btn" data-testid="retag-all" aria-describedby="retag-all-help-text" onClick={() => void lib.retagAll()}>Re-tag library now</button>
        <p className="muted small" id="retag-all-help-text" data-testid="retag-all-help">Re-analyzes every photo in the library and updates detected tags (faces aren't re-scanned). Dropbox photos pick up tag changes made in Dropbox, then Photo Tagger's tags are saved back. Adding or removing a tag on a photo already updates Dropbox — no re-tag needed.</p>
      </div>
      <div className="row wrap">
        <input className="grow" placeholder="Filter detection tags…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => { void lib.resetVocabulary(); onDirty() }} title="Puts the built-in detection list back (all chips on) and removes your custom detection tags. Tags already on photos stay.">Reset detection list</button>
      </div>
      {meta.length > 0 && (
        <div className="vocab-group" data-testid="meta-group">
          <h4>Photo metadata</h4>
          <div className="chips">
            {meta.map((l) => (
              <label key={l.id} className={`chip toggle ${offMeta.has(l.id) ? 'off' : ''}`}>
                <input type="checkbox" checked={!offMeta.has(l.id)} data-testid={`meta-${l.id}`} onChange={(e) => { void lib.toggleMetaTag(l.id, e.target.checked); onDirty() }} />
                {l.label}
              </label>
            ))}
          </div>
        </div>
      )}
      {[...groups.entries()].map(([g, ls]) => (
        <div key={g} className="vocab-group">
          <h4>{g}</h4>
          <div className="chips">
            {ls.map((l) => (
              <label key={l.id} className={`chip toggle ${off.has(l.id) ? 'off' : ''}`}>
                <input type="checkbox" checked={!off.has(l.id)} data-testid={`label-${l.id}`} onChange={(e) => { void lib.toggleLabel(l.id, e.target.checked); onDirty() }} />
                {l.label}
              </label>
            ))}
          </div>
        </div>
      ))}
      </section>
    </>
  )
}

function Data() {
  const lib = useLibrary()
  const fileRef = useRef<HTMLInputElement>(null)
  const [armed, setArmed] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  return (
    <>
      <h3>Duplicates</h3>
      <p className="muted">Exact copies (same file bytes, even with a different name) are skipped automatically when you add photos. Near-duplicates — burst shots, recompressed JPEGs, slight crops — are offered for review instead of being dropped.</p>
      <Slider
        label="Near-duplicate sensitivity"
        hint="Maximum perceptual-hash distance (0 = identical, 64 = unrelated). Lower = stricter. Default 8 catches recompress/resize; raise it to catch crops and burst shots, then review carefully."
        value={lib.settings.dupeThreshold} min={0} max={20} step={1}
        onChange={(v) => void lib.saveSettings({ dupeThreshold: v })} testId="set-dupe-threshold"
      />
      <button className="btn" data-testid="find-dupes" disabled={scanning || !lib.photos.length} onClick={async () => {
        setScanning(true)
        try { await lib.findDuplicates() } finally { setScanning(false) }
      }}>{scanning ? 'Scanning…' : 'Find duplicates in library'}</button>

      {lib.isDesktop && (
        <>
          <h3>Library folder</h3>
          <p className="muted">Originals live in this folder. Tags, thumbnails, faces and settings are stored in <code>.photo-tagger/</code> inside it. This <b>is</b> your library — the browser “save to folder” export is not used in the desktop app.</p>
          <p data-testid="library-path"><code>{lib.libraryPath || '(none chosen)'}</code></p>
          <div className="row wrap">
            <button className="btn" data-testid="change-library" onClick={() => void lib.changeLibraryFolder()}>{lib.libraryPath ? 'Change library folder…' : 'Choose library folder…'}</button>
            <button className="btn" data-testid="library-beside-settings" onClick={() => void lib.useLibraryBesideApp()}>Use folder next to the app</button>
          </div>
          {lib.portable && <p className="muted small">Portable build: app settings live in <code>data/</code> beside the executable.</p>}
        </>
      )}
      <h3>Save photos to a drive</h3>
      <p className="muted">
        {lib.isDesktop
          ? 'On desktop your library folder already holds the originals. You can still download a zip backup of tagged copies.'
          : <>Copies the photos (original if kept, otherwise the 2048&nbsp;px version) plus tags onto a folder you choose.
        The in-browser library stays the working copy — this is a backup/export, not two-way sync.
        {lib.folderSupported
          ? ' This browser can write to a live folder (Chrome / Edge on desktop).'
          : ' This browser can’t pick a live folder (Safari, Firefox, phones) — download a zip instead.'}</>}
      </p>
      {!lib.isDesktop && lib.folderSupported ? (
        <>
          <div className="row wrap">
            <button className="btn primary" data-testid="save-folder" disabled={saving || !lib.photos.length} onClick={async () => {
              setSaving(true); try { await lib.savePhotosToDisk() } finally { setSaving(false) }
            }}>{saving ? 'Saving…' : lib.folderName ? `Save library to “${lib.folderName}”` : 'Choose folder & save…'}</button>
            {lib.folderName && <button className="btn" data-testid="save-folder-change" onClick={() => void lib.chooseSaveFolder()}>Change folder…</button>}
            {lib.folderName && <button className="btn" data-testid="save-folder-clear" onClick={() => void lib.clearSaveFolder()}>Forget folder</button>}
          </div>
          <label className="check">
            <input type="checkbox" checked={lib.settings.autoSaveFolder} disabled={!lib.folderName} data-testid="set-auto-save"
              onChange={(e) => void lib.saveSettings({ autoSaveFolder: e.target.checked })} />
            <span>Auto-save newly tagged photos to that folder <small>Needs the folder permission still granted.</small></span>
          </label>
          <button className="btn" data-testid="save-zip" disabled={!lib.photos.length} onClick={() => void lib.downloadPhotosZip()}>Or download a zip…</button>
        </>
      ) : (
        <button className="btn primary" data-testid="save-zip" disabled={!lib.photos.length} onClick={() => void lib.downloadPhotosZip()}>Download library as zip…</button>
      )}
      <p className="muted">Each save writes a <code>photos/</code> folder (image + <code>.json</code> sidecar per photo) plus <code>photo-tagger.json</code> and <code>photo-tagger.csv</code>. Person tags are included. Use Select to save only the current selection.</p>

      <h3>Export tags only</h3>
      <p className="muted">Exports tags and metadata only (not the images). JSON keeps everything including your custom tags; CSV is handy for spreadsheets.</p>
      <div className="row wrap">
        <button className="btn" data-testid="export-json" onClick={() => lib.exportData('json')}>Export JSON</button>
        <button className="btn" data-testid="export-csv" onClick={() => lib.exportData('csv')}>Export CSV</button>
      </div>
      <h3>Import tags</h3>
      <p className="muted">Matches photos by file name (and size). Tags are merged into what you already have. Add the photos first, then import.</p>
      <input ref={fileRef} type="file" accept=".json,.csv,application/json,text/csv" hidden data-testid="import-input" onChange={async (e) => {
        const f = e.target.files?.[0]
        if (f) await lib.importTags(f)
        e.target.value = ''
      }} />
      <button className="btn" data-testid="import-btn" onClick={() => fileRef.current?.click()}>Import JSON or CSV…</button>
      <h3>Danger zone</h3>
      <p className="muted">{lib.isDesktop ? "Deletes every photo record, tag and derived file under .photo-tagger/ in your library folder. Original image files in the library folder are also removed from that folder." : "Deletes every photo, tag and setting stored by this app in this browser. Your original photos elsewhere are not touched."}</p>
      <button className={`btn danger ${armed ? 'armed' : ''}`} data-testid="wipe" onClick={async () => {
        if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 4000); return }
        await lib.clearEverything(); setArmed(false)
      }}>{armed ? 'Click again to delete everything' : 'Delete all local data'}</button>
    </>
  )
}

/** Settings → Tags: every tag already in the library (plus your own list entries), searchable, with rename/merge. */
function LibraryTags({ onDirty }: { onDirty: () => void }) {
  const lib = useLibrary()
  const ppl = usePeople()
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<{ from: string; to: string } | null>(null)
  const [ask, setAsk] = useState<{ from: string; to: string; ids: string[]; personId?: string; typed?: string } | null>(null)
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of lib.photos) for (const t of p.tags) m.set(t.name, (m.get(t.name) ?? 0) + 1)
    for (const c of lib.custom) { const n = normTag(c.label); if (n && !m.has(n)) m.set(n, 0) }
    return m
  }, [lib.photos, lib.custom])
  const all = useMemo(() => [...counts.keys()].sort((a, b) => a.localeCompare(b)), [counts])
  const shown = q.trim() ? matchTags(q, all, all.length) : all
  const personOnly = (name: string) => lib.photos.every((p) => !p.tags.some((t) => t.name === name && t.source !== 'person'))
  const doRename = async (from: string, to: string, ids: string[]) => {
    await lib.updatePhotos(ids, (p) => {
      const old = p.tags.find((t) => t.name === from && t.source !== 'person'); if (!old) return p
      return addTag(removeTag(p, from), to, 'manual')
    })
    lib.toast(`Renamed “${from}” to “${to}” on ${ids.length} photo(s)`, 'ok')
  }
  const personFor = (name: string) => ppl.people.find((x) => normTag(x.name) === name)
  const startRename = (from: string, typed: string) => {
    const person = personOnly(from) ? personFor(from) : undefined
    if (person) {
      setEdit(null)
      const n = typed.trim().replace(/\s+/g, ' ')
      if (!n || normTag(n) === from) return
      const ids = lib.photos.filter((p) => p.tags.some((t) => t.name === from)).map((p) => p.id)
      setAsk({ from, to: normTag(n), ids, personId: person.id, typed: n })
      return
    }
    const to = resolveTagName(typed, all.filter((t) => t !== from))
    setEdit(null)
    if (!to || to === from) return
    const ids = lib.photos.filter((p) => p.tags.some((t) => t.name === from && t.source !== 'person')).map((p) => p.id)
    if (!ids.length) { lib.toast(`“${from}” isn't on any photo yet — add “${to}” to the list instead`); return }
    setAsk({ from, to, ids })
  }
  return (
    <section className="lib-tags tag-card library" data-testid="library-tags">
      <div className="eyebrow">On your photos</div>
      <h3>Tags in your library <small className="muted">({all.length})</small></h3>
      <p className="muted small">Every tag already on your photos — people, your own, detected, Dropbox, date/camera and quality tags — plus tags you've added to this list. Renaming a person's tag renames that person (same as on the People page). Use it to review your tags, find near-duplicates, or rename one everywhere (renaming to a close spelling of another tag merges them). Changes are saved to Dropbox like any tag edit.</p>
      <div className="row wrap">
        <input className="grow" placeholder="Search tags in your library…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="library-tags-search" />
      </div>
      <ul className="lib-tag-list" data-testid="library-tags-list">
        {shown.map((t) => (
          <li key={t} data-testid="library-tag" data-tag={t}>
            {edit?.from === t ? (
              <form className="row" onSubmit={(e) => { e.preventDefault(); startRename(t, edit.to) }}>
                <input autoFocus className="grow" value={edit.to} onChange={(e) => setEdit({ from: t, to: e.target.value })} aria-label={`New name for ${t}`} data-testid="library-tag-rename-input"
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEdit(null) } }} />
                <button className="btn small primary" data-testid="library-tag-rename-save">Rename</button>
                <button type="button" className="btn small" onClick={() => setEdit(null)}>Cancel</button>
              </form>
            ) : (<>
              <span className="grow lib-tag-name">{t}</span>
              <small className="muted" data-testid="library-tag-count">{counts.get(t) ? `${counts.get(t)} photo${counts.get(t) === 1 ? '' : 's'}` : 'not on a photo yet'}</small>
              {(counts.get(t) ?? 0) > 0 && (!personOnly(t) || personFor(t)) && <button type="button" className="btn small" data-testid="library-tag-rename" onClick={() => setEdit({ from: t, to: personOnly(t) ? personFor(t)!.name : t })} aria-label={`Rename ${t}`}>Rename</button>}
            </>)}
          </li>
        ))}
        {!shown.length && <li className="muted">No tags match.</li>}
      </ul>
      <form className="row wrap" onSubmit={async (e) => {
        e.preventDefault()
        const n = resolveTagName(adding, all)
        if (!n) return
        if (counts.has(n)) { lib.toast(`“${n}” is already in your list`); setAdding(''); return }
        setBusy(true); onDirty()
        try { await lib.addCustomLabel(n, '') } finally { setBusy(false); setAdding('') }
      }}>
        <input className="grow" placeholder="Add a tag to the list…" value={adding} onChange={(e) => setAdding(e.target.value)} data-testid="library-tags-add-input" />
        <button className="btn" disabled={busy || !adding.trim()} data-testid="library-tags-add">{busy ? 'Adding…' : 'Add to list'}</button>
      </form>
      {ask && <RenameConfirm {...ask} onCancel={() => setAsk(null)} onConfirm={async () => { const a = ask; setAsk(null)
        if (a.personId) { await ppl.rename(a.personId, a.typed!); lib.toast(`Renamed person “${a.from}” to “${a.typed}”`, 'ok') } else await doRename(a.from, a.to, a.ids) }} />}
    </section>
  )
}

function RenameConfirm({ from, to, ids, onCancel, onConfirm }: { from: string; to: string; ids: string[]; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onCancel() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onCancel])
  const merge = looseTagKey(from) === looseTagKey(to)
  return (
    <div className="modal sheet" role="alertdialog" aria-modal="true" aria-labelledby="rename-title" data-testid="rename-confirm">
      <div className="sheet-card">
        <h2 id="rename-title">Rename “{from}” to “{to}”?</h2>
        <p>{merge ? `“${to}” already exists — this merges them. ` : ''}It changes the tag on {ids.length} photo{ids.length === 1 ? '' : 's'} in Photo Tagger and, for Dropbox photos, on the files' Dropbox tags.</p>
        <div className="row wrap" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" ref={cancelRef} className="btn" data-testid="rename-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn primary" data-testid="rename-confirm-btn" onClick={onConfirm}>Rename</button>
        </div>
      </div>
    </div>
  )
}
