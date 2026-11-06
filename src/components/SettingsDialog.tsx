import { useEffect, useRef, useState } from 'react'
import { DEFAULT_LABELS } from '../labels'
import { ENV_DROPBOX_KEY } from '../dropbox'
import { useLibrary } from '../store'

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
          {([['general', 'General'], ['dropbox', 'Dropbox'], ['vocab', 'Labels'], ['data', 'Data']] as const).map(([k, l]) => (
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
  const { settings, saveSettings, dropboxKey } = useLibrary()
  const [v, setV] = useState(settings.dropboxAppKey)
  return (
    <>
      <h3>Dropbox app key</h3>
      <p>
        Importing from Dropbox uses the Dropbox Chooser, which needs an <b>app key</b> from a free Dropbox app that you create. The key is not a secret
        (it is visible in the page anyway), and your photos go straight from Dropbox to this browser.
      </p>
      <ol className="steps">
        <li>Open <a href="https://www.dropbox.com/developers/apps/create" target="_blank" rel="noreferrer noopener">dropbox.com/developers/apps/create</a> and create an app (Scoped access → App folder or Full Dropbox).</li>
        <li>On the app’s <b>Settings</b> tab, add this site to <b>Chooser / Saver / Embedder domains</b>: <code data-testid="origin">{location.hostname}</code>
          <small> Enter the hostname only — no <code>https://</code>, no path, no port. Dropbox rejects values like <code>https://example.com</code>.</small></li>
        <li>Copy the <b>App key</b> and paste it below.</li>
      </ol>
      <label className="field">
        <span>App key</span>
        <input data-testid="dropbox-key" value={v} placeholder={ENV_DROPBOX_KEY ? '(using the build-time key)' : 'e.g. a1b2c3d4e5f6g7h'} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setV(e.target.value.trim())} />
      </label>
      <div className="row wrap">
        <button className="btn primary" data-testid="dropbox-save" onClick={() => saveSettings({ dropboxAppKey: v })}>Save key</button>
        <span className="muted">{dropboxKey ? 'A key is configured – the Dropbox button is active.' : 'No key set yet.'}</span>
      </div>
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
  return (
    <>
      <p className="muted">
        Photos are matched against this list of labels. Switch labels off if you never want them, or add your own (for example “bike race”, “my dog Rex”,
        “whiteboard notes”). The first custom label downloads a text model (≈72&nbsp;MB, once).
      </p>
      <form className="add-label" onSubmit={async (e) => {
        e.preventDefault()
        if (!label.trim()) return
        setBusy(true); onDirty()
        await lib.addCustomLabel(label, prompt)
        setBusy(false); setLabel(''); setPrompt('')
      }}>
        <input data-testid="custom-label" placeholder="New label, e.g. lighthouse" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input data-testid="custom-prompt" placeholder="Optional description, e.g. a photo of a lighthouse by the sea" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button className="btn primary" data-testid="custom-add" disabled={busy || !label.trim()}>{busy ? 'Adding…' : 'Add label'}</button>
      </form>
      {lib.custom.length > 0 && (
        <div className="vocab-group">
          <h4>Your labels</h4>
          <div className="chips">
            {lib.custom.map((c) => (
              <span key={c.id} className="chip src-manual static" data-testid="custom-chip">{c.label}
                <button aria-label={`Delete label ${c.label}`} onClick={() => { void lib.removeCustomLabel(c.id); onDirty() }}>×</button>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="row wrap">
        <input className="grow" placeholder="Filter labels…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" data-testid="retag-all" onClick={() => void lib.retagAll()}>Re-tag library now</button>
        <button className="btn" onClick={() => { void lib.resetVocabulary(); onDirty() }}>Reset labels</button>
      </div>
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
          <button className="btn" data-testid="change-library" onClick={() => void lib.changeLibraryFolder()}>{lib.libraryPath ? 'Change library folder…' : 'Choose library folder…'}</button>
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
      <p className="muted">Exports tags and metadata only (not the images). JSON keeps everything including your custom labels; CSV is handy for spreadsheets.</p>
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
