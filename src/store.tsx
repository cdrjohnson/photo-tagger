import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as DB from './storage'
import { ml, type ModelProgress, type ModelState } from './ml/client'
import { applyAutoTags, buildVocab, scoreTags, type VocabEntry } from './tagging'
import { addTag, applyMetaTags, META_TAGS, normTag, removeTag } from './tags'
import { DEFAULT_LABELS } from './labels'
import { fingerprint, hashesFromBlob, isImageFile, pixelsFromBlob, prepare, type Prepared } from './ingest'
import { nearestPhash } from './hashes'
import { buildZip, canPickFolder, clearSavedFolder, downloadBlob, ensurePermission, getSavedFolder, pickFolder, saveOneToFolder, saveToFolder, type DirHandle } from './folderSave'
import { qualityFlags } from './imageUtils'
import { completeWebRedirect, DropboxClient, ENV_DROPBOX_KEY, isDropboxMedia, orderDropboxFiles, type DropboxAddOrder, isDropboxVideo, setActiveDropbox, startDropboxAuth, type DropboxEntry, type DropboxFile, type DropboxSession } from './dropbox'
import * as Remote from './remote'
import { fetchDropboxOriginal } from './dropbox'
import { parseImport, toCSV, toJSON, download } from './exportImport'
import { DEFAULT_SETTINGS, type CustomLabel, type DropboxRef, type Photo, type Settings, type Tag } from './types'


// ---------- per-folder import progress (1.0.27) ----------
/** Progress is derived from the library (Dropbox file ids in the sidecars); only two tiny local records exist. */
export interface FolderProgress { path: string; recursive: boolean; total: number; inLibrary: number; skipped: number; remaining: number }
const SKIP_KEY = 'pt.dropboxSkipped.v1', RUN_KEY = 'pt.dropboxRun.v1'
/** Dropbox file ids that can't be imported (duplicate content, video without a preview) so "All in library" isn't blocked forever */
/**
 * 1.0.33: a brand-new setup (no saved settings, empty library, no Dropbox connection, no custom tags) starts with every
 * automatic tag OFF. Anyone with saved settings or an existing library keeps exactly what they had.
 * (The e2e suite keeps the old all-on default unless a test asks for a fresh setup.)
 */
async function initialSettings(saved: Partial<Settings> | undefined | null, photoCount: number, customCount: number): Promise<Settings> {
  if (saved) return { ...DEFAULT_SETTINGS, ...saved }
  const w = window as any
  const fresh = !photoCount && !customCount
    && !(await DB.kvGet<DropboxSession>('dropboxSession').catch(() => null))
    && !(await DB.kvGet<LinkedFolder[]>('dropboxFolders').catch(() => null))?.length
    && !(w.__PT_E2E__ && localStorage.getItem('pt.e2eFresh') !== '1')
  if (!fresh) return { ...DEFAULT_SETTINGS }
  const off: Settings = { ...DEFAULT_SETTINGS, disabledLabels: DEFAULT_LABELS.map((l) => l.id), disabledMetaTags: META_TAGS.map((m) => m.id) }
  await DB.kvSet('settings', off).catch(() => {})
  return off
}
export function skippedFiles(): Record<string, string> { try { return JSON.parse(localStorage.getItem(SKIP_KEY) || '{}') } catch { return {} } }
function markSkipped(id: string, reason: string) { try { const m = skippedFiles(); m[id] = reason; localStorage.setItem(SKIP_KEY, JSON.stringify(m)) } catch { /* ignore */ } }
export type RunRecord = { path: string; recursive: boolean; at: number }
export function runRecord(): RunRecord | null { try { return JSON.parse(localStorage.getItem(RUN_KEY) || 'null') } catch { return null } }
export function setRunRecord(r: RunRecord | null) { try { if (r) localStorage.setItem(RUN_KEY, JSON.stringify(r)); else localStorage.removeItem(RUN_KEY) } catch { /* ignore */ } }

export interface Job { label: string; total: number; done: number; failed: number; /** true only while Dropbox files are downloading */ cancellable?: boolean }
export interface Toast { id: number; text: string; kind: 'info' | 'error' | 'ok' }
export interface ModelInfo { state: ModelState; phase: ModelProgress['phase']; loaded: number; total: number; error: string }

export interface Library {
  ready: boolean
  photos: Photo[]
  settings: Settings
  custom: CustomLabel[]
  job: Job | null
  model: ModelInfo
  toasts: Toast[]
  pendingCount: number
  dropboxKey: string
  addFiles(files: File[], source?: Photo['source']): Promise<void>
  /** Dropbox as the library (OAuth + in-app browser). */
  dropbox: DropboxState
  connectDropbox(): Promise<void>
  disconnectDropbox(): Promise<void>
  listDropbox(path: string): Promise<DropboxEntry[]>
  dropboxThumb(f: { id: string; path: string; rev?: string }): Promise<string | null>
  /** Tag every new image in a Dropbox folder; originals are not kept locally. */
  processDropboxFolder(path: string, recursive: boolean): Promise<void>
  processDropboxFiles(files: DropboxFile[]): Promise<void>
  /** true while "Check your detection list first" is waiting for an answer (empty library, 1.0.27) */
  preImportAsk: boolean
  /** answer the pre-import check: proceed starts the import; review/cancel start nothing */
  answerPreImport(choice: 'proceed' | 'review' | 'cancel', dontAskAgain: boolean): void
  /** Re-scan remembered Dropbox folders and process only files not yet in the library. */
  refreshDropbox(): Promise<void>
  /** per-folder import progress derived from the library (metadata listing only, no downloads) */
  dropboxFolderProgress(path: string, recursive: boolean): Promise<FolderProgress>
  /** add the next `count` (default: Photos per batch) not-yet-imported files of a folder, in the saved order (name / oldest / newest) */
  addNextDropboxBatch(path: string, recursive: boolean, count?: number): Promise<void>
  /** add every remaining file of a folder, in batches */
  addAllRemainingDropbox(path: string, recursive: boolean): Promise<void>
  /** every photo/video in a folder (metadata only, no downloads), with Dropbox's dates */
  dropboxFolderFiles(path: string, recursive: boolean): Promise<DropboxFile[]>
  /** add these files plus everything in these folders (picked in the browser, or a date range) through the batch pipeline; folders are not linked */
  addDropboxSelection(files: DropboxFile[], folders?: string[], recursive?: boolean): Promise<void>
  forgetDropboxFolder(path: string): Promise<void>
  /** Abort remaining Dropbox downloads; already-finished files are still tagged. */
  cancelDropboxDownload(): void
  updatePhotos(ids: string[], fn: (p: Photo) => Photo): Promise<void>
  addTags(ids: string[], names: string[]): Promise<void>
  removeTags(ids: string[], names: string[]): Promise<void>
  deletePhotos(ids: string[]): Promise<void>
  /** 1.0.33: delete these Dropbox photos' files from Dropbox (queued, paced, retried) and remove them from the library */
  trashDropboxPhotos(ids: string[]): Promise<void>
  retagAll(): Promise<void>
  retagPhoto(id: string): Promise<void>
  /** read this Dropbox photo's tags from Dropbox now (detail view open) */
  pullDropboxTags(id: string): Promise<void>
  retryPending(): Promise<void>
  saveSettings(s: Partial<Settings>): Promise<void>
  addCustomLabel(label: string, prompt?: string): Promise<void>
  removeCustomLabel(id: string): Promise<void>
  toggleLabel(id: string, on: boolean): Promise<void>
  toggleMetaTag(id: string, on: boolean): Promise<void>
  resetVocabulary(): Promise<void>
  /** 1.0.32: switch every automatic tag at once ('off'), back to all on ('on') or to how it was before 'off' ('restore'). New photos only. */
  setAllAutoTags(mode: 'off' | 'on' | 'restore'): Promise<void>
  exportData(kind: 'json' | 'csv', ids?: string[]): void
  importTags(file: File): Promise<void>
  clearEverything(): Promise<void>
  toast(text: string, kind?: Toast['kind']): void
  preloadModel(): Promise<void>
  /** called after each newly added photo has been tagged (used by face recognition) */
  setAfterIngest(fn: ((photoId: string) => Promise<void>) | null): void
  /** near-duplicates waiting for the user to keep, skip, or mark */
  nearDupes: NearDupe[]
  resolveNearDupe(id: string, action: 'keep' | 'skip' | 'mark'): Promise<void>
  resolveAllNearDupes(action: 'keep' | 'skip'): Promise<void>
  findDuplicates(): Promise<number>
  dismissDupePair(a: string, b: string): Promise<void>
  /** folder save (Chromium) / zip fallback */
  folderSupported: boolean
  folderName: string | null
  chooseSaveFolder(): Promise<void>
  clearSaveFolder(): Promise<void>
  savePhotosToDisk(ids?: string[]): Promise<void>
  downloadPhotosZip(ids?: string[]): Promise<void>
  /** Tauri desktop: absolute path of the chosen library folder, or null until picked */
  libraryPath: string | null
  isDesktop: boolean
  chooseLibraryFolder(): Promise<void>
  changeLibraryFolder(): Promise<void>
  /** true when running from a portable folder (portable.txt beside the exe) */
  portable: boolean
  useLibraryBesideApp(): Promise<void>
}

export interface LinkedFolder { path: string; recursive: boolean; lastSync?: number }
export interface DropboxState {
  connected: boolean
  account: string
  folders: LinkedFolder[]
  /** a sign-in is in progress (desktop waits for the browser) */
  connecting: boolean
}

export interface NearDupe {
  /** pending ingest: prepared photo not yet saved; library scan: existing photo id */
  kind: 'ingest' | 'library'
  id: string
  name: string
  matchId: string
  matchName: string
  distance: number
  /** only for kind=ingest */
  prep?: Prepared
}

const Ctx = createContext<Library | null>(null)
export const useLibrary = () => useContext(Ctx)!

let toastSeq = 1

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [custom, setCustom] = useState<CustomLabel[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [model, setModel] = useState<ModelInfo>({ state: 'idle', phase: 'vision', loaded: 0, total: 0, error: '' })
  const [toasts, setToasts] = useState<Toast[]>([])
  const [nearDupes, setNearDupes] = useState<NearDupe[]>([])
  const [folderName, setFolderName] = useState<string | null>(null)
  const [libraryPath, setLibraryPath] = useState<string | null>(null)
  const [portable, setPortable] = useState(false)
  const [dbxSession, setDbxSession] = useState<DropboxSession | null>(null)
  const [dbxFolders, setDbxFolders] = useState<LinkedFolder[]>([])
  const [dbxConnecting, setDbxConnecting] = useState(false)
  const dbxClientRef = useRef<DropboxClient | null>(null)
  const dbxFoldersRef = useRef<LinkedFolder[]>([])

  const photosRef = useRef<Photo[]>([])
  const nearRef = useRef<NearDupe[]>([])
  const ingestPrepRef = useRef<Map<string, Prepared>>(new Map())
  const resolvingDupes = useRef(new Set<string>())
  const folderRef = useRef<DirHandle | null>(null)
  const setNearBoth = (list: NearDupe[]) => { nearRef.current = list; setNearDupes(list) }
  const settingsRef = useRef(settings)
  const customRef = useRef(custom)
  const customEmb = useRef(new Map<string, Float32Array>())
  const queue = useRef<{ file: File; source: Photo['source'] }[]>([])
  const running = useRef(false)
  const jobRef = useRef<Job | null>(null)
  const dropboxAbortRef = useRef<AbortController | null>(null)
  /** pending "Check your detection list first" question (resolves true = go ahead) */
  const preImportRef = useRef<((go: boolean) => void) | null>(null)
  const [preImportAsk, setPreImportAsk] = useState(false)
  /** Before the first import into an empty library, ask the user to check the Detection list (nothing is downloaded until they answer). */
  const confirmFirstImport = useCallback((): Promise<boolean> => {
    if (photosRef.current.length > 0 || settingsRef.current.askBeforeFirstImport === false) return Promise.resolve(true)
    if (preImportRef.current) return Promise.resolve(false)
    return new Promise<boolean>((res) => { preImportRef.current = res; setPreImportAsk(true) })
  }, [])
  const modelFailed = useRef(false)
  /** Face-detection models failed once — toast once, then skip without spamming. */
  const faceFailed = useRef(false)
  const afterIngest = useRef<((photoId: string) => Promise<void>) | null>(null)
  const setAfterIngest = useCallback((fn: ((photoId: string) => Promise<void>) | null) => { afterIngest.current = fn }, [])

  const setPhotosBoth = useCallback((fn: (p: Photo[]) => Photo[]) => {
    photosRef.current = fn(photosRef.current)
    setPhotos(photosRef.current)
  }, [])
  const setJobBoth = (j: Job | null) => { jobRef.current = j; setJob(j) }

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = toastSeq++
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000)
  }, [])

  // ---------- load ----------
  useEffect(() => {
    (async () => {
      const desktop = DB.isDesktop()
      if (desktop) {
        const port = await DB.isPortable().catch(() => false)
        setPortable(!!port)
        const path = await DB.getLibraryPath().catch(() => null)
        setLibraryPath(path)
        if (!path) {
          setReady(true)
          return
        }
      }
      const [ps, s, c, ce] = await Promise.all([
        DB.allPhotos(),
        DB.kvGet<Partial<Settings>>('settings'),
        DB.kvGet<CustomLabel[]>('custom'),
        DB.kvGet<Record<string, number[]>>('customEmb'),
      ])
      if (!desktop) getSavedFolder().then((h) => { folderRef.current = h; setFolderName(h?.name ?? null) }).catch(() => {})
      const merged = await initialSettings(s, ps.length, c?.length ?? 0)
      if (desktop) merged.keepOriginals = true
      settingsRef.current = merged; setSettings(merged)
      customRef.current = c ?? []; setCustom(c ?? [])
      const embMap = new Map<string, Float32Array>()
      for (const [k, v] of Object.entries(ce ?? {})) embMap.set(k, v instanceof Float32Array ? v : Float32Array.from(v as number[]))
      customEmb.current = embMap
      photosRef.current = ps; setPhotos(ps)
      await loadDropboxState(merged)
      setReady(true)
      if (!desktop) navigator.storage?.persist?.().catch(() => {})
    })()
    ml.onProgress = (p) => setModel((m) => ({ ...m, phase: p.phase, loaded: p.loaded, total: p.total }))
    ml.onState = (state) => setModel((m) => ({ ...m, state, error: ml.error }))
  }, [])

  const dropboxKey = settings.dropboxAppKey || ENV_DROPBOX_KEY

  // ---------- Dropbox session ----------
  /** Copy photos whose tags changed in the Dropbox layer (native tag import) into app state. */
  const syncFromRemote = (ids: string[]) => {
    if (!ids.length) return
    const byId = new Map(Remote.remotePhotos().filter((p) => ids.includes(p.id)).map((p) => [p.id, p]))
    setPhotosBoth((all) => all.map((p) => byId.get(p.id) ?? p))
  }
  const syncFromRemoteRef = useRef(syncFromRemote); syncFromRemoteRef.current = syncFromRemote
  useEffect(() => Remote.onRemotePhotos((ids) => syncFromRemoteRef.current(ids)), [])
  const pullDropboxTags = useCallback(async (id: string) => {
    if (!photosRef.current.find((x) => x.id === id)?.dropbox) return
    syncFromRemoteRef.current(await Remote.importNativeTags([id]))
  }, [])
  const reloadPhotos = async () => {
    const ps = await DB.allPhotos()
    photosRef.current = ps; setPhotos(ps)
  }
  const applyDropboxSession = (s: DropboxSession | null, key: string) => {
    if (s && key) {
      const c = new DropboxClient(key, s, (next) => { setDbxSession(next); void DB.kvSet('dropboxSession', next) })
      dbxClientRef.current = c
      setActiveDropbox(c)
      // Dropbox photos + their tags/faces are read from Dropbox (sidecars), never from local storage
      void Remote.loadFromDropbox(c).then(reloadPhotos).then(Remote.notifyRemote).then(() => Remote.importNativeTags()).then(syncFromRemote).catch((e: any) => toast(`Could not load tags from Dropbox: ${e?.message || e}`, 'error'))
    } else {
      dbxClientRef.current = null
      setActiveDropbox(null)
      Remote.clearMemory()
      void reloadPhotos().then(Remote.notifyRemote)
    }
    setDbxSession(s)
  }
  useEffect(() => {
    let warned = false
    // only problems that retrying can't fix reach here (transient ones are retried by the queue and shown in its bar)
    Remote.setWriteErrorHandler((e: any) => { if (!warned) { warned = true; toast(`Could not save to Dropbox: ${e?.message || e}`, 'error') } })
    // reading tags is not saving: say so, and only once per session
    let readWarned = false
    Remote.setReadErrorHandler((e: any, n: number) => { if (!readWarned) { readWarned = true; toast(`Could not read Dropbox tags for ${n} photo${n === 1 ? '' : 's'} (${e?.message || e}). Their tags in Photo Tagger are unchanged; they are checked again on Refresh or next start.`, 'error') } })
    // closing while tags are still being written: warn (web); either way the queue resumes on next open
    const leave = (e: BeforeUnloadEvent) => { if (Remote.pendingWrites() > 0 && !(window as any).__PT_E2E__) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', leave)
    return () => { Remote.setWriteErrorHandler(null); Remote.setReadErrorHandler(null); window.removeEventListener('beforeunload', leave) }
  }, [toast])
  async function loadDropboxState(st: Settings) {
    const key = st.dropboxAppKey || ENV_DROPBOX_KEY
    const [sess, folders] = await Promise.all([
      DB.kvGet<DropboxSession>('dropboxSession').catch(() => undefined),
      DB.kvGet<LinkedFolder[]>('dropboxFolders').catch(() => undefined),
    ])
    dbxFoldersRef.current = folders ?? []; setDbxFolders(folders ?? [])
    let session = sess ?? null
    try {
      const back = await completeWebRedirect()
      if (back === 'error') toast('Dropbox sign-in was cancelled', 'error')
      else if (back) {
        session = back
        try {
          const tmp = new DropboxClient(key, back, (n) => { session = n })
          const a = await tmp.account()
          session = { ...tmp.session, name: a.name, email: a.email, accountId: a.accountId }
        } catch { /* account_info.read not granted — stay connected without a name */ }
        await DB.kvSet('dropboxSession', session)
        toast('Dropbox connected', 'ok')
      }
    } catch (e: any) {
      toast(e?.message || 'Dropbox sign-in failed', 'error')
    }
    applyDropboxSession(session, key)
  }

  // ---------- helpers ----------
  const persist = useCallback(async (p: Photo) => {
    await DB.putPhoto(p)
    setPhotosBoth((all) => all.map((x) => (x.id === p.id ? p : x)))
  }, [setPhotosBoth])

  const vocab = useCallback((): VocabEntry[] => buildVocab(settingsRef.current, customRef.current, customEmb.current), [])

  const ensureModel = useCallback(async () => {
    await ml.init(settingsRef.current.modelHost)
  }, [])

  const tagWithEmbedding = useCallback(async (p: Photo, emb: Float32Array) => {
    const s = settingsRef.current
    const auto = scoreTags(emb, vocab(), s.threshold, s.maxTags)
    const next = applyAutoTags(p, auto)
    await persist(next)
  }, [persist, vocab])

  const bumpJob = (patch: Partial<Job>) => {
    if (jobRef.current) setJobBoth({ ...jobRef.current, ...patch })
  }
  const endJob = () => setTimeout(() => { if (jobRef.current && jobRef.current.done >= jobRef.current.total) setJobBoth(null) }, 1500)

  const reportTaggingFailure = useCallback((e: any) => {
    if (!modelFailed.current) {
      toast(`Tagging model unavailable: ${e?.message || e}. Photos are saved untagged. After updating or reloading, use "Retry tagging".`, 'error')
    }
    modelFailed.current = true
  }, [toast])

  // ---------- ingest helpers ----------
  const finishPhoto = useCallback(async (prep: Prepared) => {
    await DB.savePhotoWithBlobs(prep.photo, prep.blobs)
    setPhotosBoth((all) => {
      const i = all.findIndex((p) => p.id === prep.photo.id)
      if (i >= 0) { const next = all.slice(); next[i] = prep.photo; return next }
      return [...all, prep.photo]
    })
    // let React commit the new tile before CLIP / face work (keeps Keep responsive)
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    if (!modelFailed.current) {
      try {
        await ensureModel()
        const emb = await ml.embedImage(prep.rgb, prep.rw, prep.rh)
        await DB.putEmbedding(prep.photo.id, emb)
        await tagWithEmbedding(prep.photo, emb)
      } catch (e: any) {
        reportTaggingFailure(e)
      }
    }
    if (afterIngest.current && !faceFailed.current) {
      try {
        await afterIngest.current(prep.photo.id)
      } catch (e: any) {
        faceFailed.current = true
        toast(`Face detection unavailable: ${e?.message || e}. Photos still import and tag; face naming is skipped until you reload.`, 'error')
      }
    }
    // optional auto-save to remembered folder
    if (settingsRef.current.autoSaveFolder && folderRef.current) {
      try { await saveOneToFolder(folderRef.current, prep.photo) } catch { /* permission may have lapsed */ }
    }
  }, [ensureModel, reportTaggingFailure, setPhotosBoth, tagWithEmbedding, toast])

  // ---------- ingest ----------
  const run = useCallback(async () => {
    if (running.current) return
    running.current = true
    // Keep a failed backend paused across streamed Dropbox batches, not just one run.
    let exactSkipped = 0
    try {
      while (queue.current.length) {
        const item = queue.current.shift()!
        bumpJob({ label: `Processing ${item.file.name}` })
        try {
          const prep = await prepare(item.file, item.source, settingsRef.current)
          // exact content match (renamed / re-exported same bytes)
          const same = photosRef.current.find((p) => p.contentHash && p.contentHash === prep.contentHash)
            ?? nearRef.current.find((n) => n.prep?.contentHash === prep.contentHash)
          if (same) { exactSkipped++; bumpJob({ done: (jobRef.current?.done ?? 0) + 1 }); continue }
          // near-duplicate by perceptual hash
          const near = nearestPhash(prep.photo.phash!, photosRef.current, settingsRef.current.dupeThreshold)
          if (near) {
            const match = photosRef.current.find((p) => p.id === near.id)!
            ingestPrepRef.current.set(prep.photo.id, prep)
            setNearBoth([...nearRef.current, {
              kind: 'ingest', id: prep.photo.id, name: prep.photo.name,
              matchId: match.id, matchName: match.name, distance: near.distance, prep,
            }])
            bumpJob({ done: (jobRef.current?.done ?? 0) + 1 })
            continue
          }
          await finishPhoto(prep)
        } catch (e: any) {
          bumpJob({ failed: (jobRef.current?.failed ?? 0) + 1 })
          toast(`Could not read ${item.file.name}: ${e.message || 'unsupported image'}`, 'error')
        }
        bumpJob({ done: (jobRef.current?.done ?? 0) + 1 })
      }
    } finally {
      running.current = false
      endJob()
      if (exactSkipped) toast(`${exactSkipped} duplicate photo(s) skipped`)
    }
  }, [finishPhoto, toast])

  const addFiles = useCallback(async (files: File[], source: Photo['source'] = 'device') => {
    const imgs = files.filter(isImageFile)
    if (imgs.length < files.length) toast(`${files.length - imgs.length} non-image file(s) skipped`)
    const have = new Set(photosRef.current.map((p) => p.fp))
    for (const q of queue.current) have.add(fingerprint({ name: q.file.name, size: q.file.size, lastModified: q.source === 'device' ? q.file.lastModified : 0 }))
    const fresh: File[] = []
    let dupes = 0
    for (const f of imgs) {
      const fp = fingerprint({ name: f.name, size: f.size, lastModified: source === 'device' ? f.lastModified : 0 })
      if (have.has(fp)) { dupes++; continue }
      have.add(fp); fresh.push(f)
    }
    if (dupes) toast(`${dupes} duplicate photo(s) skipped`)
    if (!fresh.length) {
      // finish a preceding Dropbox download job that had nothing left to process
      if (jobRef.current && jobRef.current.done >= jobRef.current.total && jobRef.current.total > 0) endJob()
      return
    }
    queue.current.push(...fresh.map((file) => ({ file, source })))
    const cur = jobRef.current
    // Continue a Dropbox download job into tagging (one continuous bar), else start/extend as before
    const continuing = !!(cur && cur.total > 0 && cur.done >= cur.total && /Dropbox|Downloading/i.test(cur.label))
    setJobBoth({
      label: '',
      total: continuing ? cur!.done + fresh.length : (cur?.total ?? 0) + fresh.length,
      done: continuing ? cur!.done : (cur?.done ?? 0),
      failed: cur?.failed ?? 0,
    })
    void run()
  }, [run, toast])

  const patchPhotos = useCallback(async (ids: string[], fn: (p: Photo) => Photo) => {
    const set = new Set(ids)
    const next = photosRef.current.filter((p) => set.has(p.id)).map(fn)
    await Promise.all(next.map((p) => DB.putPhoto(p)))
    const byId = new Map(next.map((p) => [p.id, p]))
    setPhotosBoth((all) => all.map((p) => byId.get(p.id) ?? p))
  }, [setPhotosBoth])

  const resolveNearDupe = useCallback(async (id: string, action: 'keep' | 'skip' | 'mark') => {
    const item = nearRef.current.find((n) => n.id === id)
    if (!item) return
    if (resolvingDupes.current.has(id)) return
    resolvingDupes.current.add(id)
    // remove from the review list immediately so Keep all / repeated clicks cannot re-queue it
    setNearBoth(nearRef.current.filter((n) => n.id !== id))
    try {
      if (item.kind === 'ingest') {
        const base = ingestPrepRef.current.get(id) ?? item.prep
        if (action === 'skip') { ingestPrepRef.current.delete(id); return }
        if (!base) { ingestPrepRef.current.delete(id); toast('Could not keep that photo (data was lost)', 'error'); return }
        const prep = { ...base, photo: action === 'mark' ? { ...base.photo, duplicateOf: item.matchId } : { ...base.photo } }
        try {
          await finishPhoto(prep)
        } catch (e: any) {
          toast(`Could not keep ${item.name}: ${e.message || e}`, 'error')
        } finally {
          ingestPrepRef.current.delete(id)
        }
        return
      }
      if (action === 'keep') {
        await patchPhotos([item.id, item.matchId], (p) => {
          const other = p.id === item.id ? item.matchId : item.id
          return { ...p, ignoredDupes: [...new Set([...(p.ignoredDupes ?? []), other])] }
        })
        return
      }
      if (action === 'mark') await patchPhotos([item.id], (p) => ({ ...p, duplicateOf: item.matchId }))
    } finally {
      resolvingDupes.current.delete(id)
    }
  }, [finishPhoto, patchPhotos, toast])

  const resolveAllNearDupes = useCallback(async (action: 'keep' | 'skip') => {
    const list = [...nearRef.current]
    setNearBoth([]) // clear UI immediately; each item is processed from the snapshot below
    for (const item of list) {
      if (resolvingDupes.current.has(item.id)) continue
      resolvingDupes.current.add(item.id)
      try {
        if (item.kind === 'ingest') {
          const base = ingestPrepRef.current.get(item.id) ?? item.prep
          if (action === 'skip') { ingestPrepRef.current.delete(item.id); continue }
          if (!base) { ingestPrepRef.current.delete(item.id); continue }
          const prep = { ...base, photo: { ...base.photo } }
          try { await finishPhoto(prep) } catch (e: any) { toast(`Could not keep ${item.name}: ${e.message || e}`, 'error') }
          finally { ingestPrepRef.current.delete(item.id) }
        } else if (action === 'keep') {
          await patchPhotos([item.id, item.matchId], (p) => {
            const other = p.id === item.id ? item.matchId : item.id
            return { ...p, ignoredDupes: [...new Set([...(p.ignoredDupes ?? []), other])] }
          })
        }
        // library + skip = just dismiss (already cleared from the list)
      } finally {
        resolvingDupes.current.delete(item.id)
      }
    }
  }, [finishPhoto, patchPhotos, toast])

  const ensureHashes = useCallback(async () => {
    const missing = photosRef.current.filter((p) => !p.phash || !p.contentHash)
    for (const p of missing) {
      const blob = (p.hasOriginal ? await DB.getBlob('originals', p.id) : null) ?? await DB.getBlob('views', p.id)
      if (!blob) continue
      try {
        const h = await hashesFromBlob(blob)
        await patchPhotos([p.id], (x) => ({ ...x, contentHash: h.contentHash, phash: h.phash }))
      } catch { /* skip undecodable */ }
    }
  }, [patchPhotos])

  const findDuplicates = useCallback(async () => {
    toast('Scanning library for near-duplicates…')
    await ensureHashes()
    const thr = settingsRef.current.dupeThreshold
    const list = photosRef.current
    const seen = new Set<string>()
    const found: NearDupe[] = []
    for (const p of list) {
      if (!p.phash || p.duplicateOf) continue
      const near = nearestPhash(p.phash, list, thr, p.id)
      if (!near) continue
      const key = [p.id, near.id].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      const other = list.find((x) => x.id === near.id)!
      if (other.duplicateOf === p.id || p.duplicateOf === other.id) continue
      if (p.ignoredDupes?.includes(other.id) || other.ignoredDupes?.includes(p.id)) continue
      found.push({ kind: 'library', id: p.id, name: p.name, matchId: other.id, matchName: other.name, distance: near.distance })
    }
    setNearBoth([...nearRef.current.filter((n) => n.kind === 'ingest'), ...found])
    toast(found.length ? `Found ${found.length} near-duplicate pair(s) to review` : 'No near-duplicates found', found.length ? 'info' : 'ok')
    return found.length
  }, [ensureHashes, toast])

  const dismissDupePair = useCallback(async (a: string, b: string) => {
    await patchPhotos([a, b], (p) => {
      const other = p.id === a ? b : a
      return { ...p, ignoredDupes: [...new Set([...(p.ignoredDupes ?? []), other])] }
    })
    setNearBoth(nearRef.current.filter((n) => !((n.id === a && n.matchId === b) || (n.id === b && n.matchId === a))))
  }, [patchPhotos])

  // ---------- folder / zip save ----------
  const chooseSaveFolder = useCallback(async () => {
    try {
      const h = await pickFolder()
      folderRef.current = h
      setFolderName(h.name)
      toast(`Save folder set to “${h.name}”`, 'ok')
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast(e.message || 'Could not open folder', 'error')
    }
  }, [toast])

  const clearSaveFolderFn = useCallback(async () => {
    await clearSavedFolder()
    folderRef.current = null
    setFolderName(null)
    const next = { ...settingsRef.current, autoSaveFolder: false }
    settingsRef.current = next; setSettings(next)
    await DB.kvSet('settings', next)
    toast('Save folder forgotten')
  }, [toast])

  const savePhotosToDisk = useCallback(async (ids?: string[]) => {
    const set = ids ? new Set(ids) : null
    const list = photosRef.current.filter((p) => !set || set.has(p.id))
    if (!list.length) { toast('No photos to save'); return }
    try {
      let dir = folderRef.current
      if (!dir || !(await ensurePermission(dir))) {
        dir = await pickFolder()
        folderRef.current = dir
        setFolderName(dir.name)
      }
      const r = await saveToFolder(dir, list, settingsRef.current, customRef.current)
      toast(`Saved ${r.ok} photo(s) to “${r.folderName}”${r.failed ? ` (${r.failed} failed)` : ''}`, r.failed ? 'error' : 'ok')
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      toast(e.message || 'Save failed', 'error')
    }
  }, [toast])

  const downloadPhotosZip = useCallback(async (ids?: string[]) => {
    const set = ids ? new Set(ids) : null
    const list = photosRef.current.filter((p) => !set || set.has(p.id))
    if (!list.length) { toast('No photos to save'); return }
    try {
      toast(`Building zip of ${list.length} photo(s)…`)
      const blob = await buildZip(list, settingsRef.current, customRef.current)
      const stamp = new Date().toISOString().slice(0, 10)
      downloadBlob(`photo-tagger-${stamp}.zip`, blob)
      toast(`Downloaded photo-tagger-${stamp}.zip`, 'ok')
    } catch (e: any) {
      toast(e.message || 'Zip failed', 'error')
    }
  }, [toast])


  const chooseLibraryFolder = useCallback(async () => {
    try {
      const path = await DB.pickLibraryFolder()
      setLibraryPath(path)
      const [ps, st, c, ce] = await Promise.all([
        DB.allPhotos(),
        DB.kvGet<Partial<Settings>>('settings'),
        DB.kvGet<CustomLabel[]>('custom'),
        DB.kvGet<Record<string, number[]>>('customEmb'),
      ])
      const merged = { ...(await initialSettings(st, ps.length, c?.length ?? 0)), keepOriginals: true }
      settingsRef.current = merged; setSettings(merged)
      customRef.current = c ?? []; setCustom(c ?? [])
      const embMap = new Map<string, Float32Array>()
      for (const [k, v] of Object.entries(ce ?? {})) embMap.set(k, v instanceof Float32Array ? v : Float32Array.from(v as number[]))
      customEmb.current = embMap
      photosRef.current = ps; setPhotos(ps)
      await loadDropboxState(merged)
      toast(`Library folder: ${path}`, 'ok')
    } catch (e: any) {
      if (String(e?.message || e).includes('No folder')) return
      toast(e?.message || 'Could not open library folder', 'error')
    }
  }, [toast])

  const changeLibraryFolder = useCallback(async () => {
    await chooseLibraryFolder()
  }, [chooseLibraryFolder])

  const useLibraryBesideApp = useCallback(async () => {
    try {
      const path = await DB.useLibraryBesideApp()
      setLibraryPath(path)
      const [ps, st, c, ce] = await Promise.all([
        DB.allPhotos(),
        DB.kvGet<Partial<Settings>>('settings'),
        DB.kvGet<CustomLabel[]>('custom'),
        DB.kvGet<Record<string, number[]>>('customEmb'),
      ])
      const merged = { ...(await initialSettings(st, ps.length, c?.length ?? 0)), keepOriginals: true }
      settingsRef.current = merged; setSettings(merged)
      customRef.current = c ?? []; setCustom(c ?? [])
      const embMap = new Map<string, Float32Array>()
      for (const [k, v] of Object.entries(ce ?? {})) embMap.set(k, v instanceof Float32Array ? v : Float32Array.from(v as number[]))
      customEmb.current = embMap
      photosRef.current = ps; setPhotos(ps)
      await loadDropboxState(merged)
      toast(`Library folder: ${path}`, 'ok')
    } catch (e: any) {
      toast(e?.message || 'Could not create library beside the app', 'error')
    }
  }, [toast])

  const cancelDropboxDownload = useCallback(() => {
    dropboxAbortRef.current?.abort()
  }, [])


  const isTransient = (e: any) => {
    const msg = String(e?.message || e)
    const status = Number(e?.status || /\((\d{3})\)/.exec(msg)?.[1] || 0)
    return e?.name === 'AbortError' || e?.name === 'TypeError'
      || /failed to fetch|network|aborted|abort/i.test(msg)
      || status === 429 || status >= 500
  }
  const downloadWithRetry = async (c: DropboxClient, f: DropboxFile, signal: AbortSignal, attempts = 3) => {
    let last: unknown
    for (let n = 1; n <= attempts; n++) {
      // User cancel — never retry
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        return await c.download(f, signal)
      } catch (e: any) {
        last = e
        // Abort from our Cancel button — stop. AbortError without user cancel (e.g. Firefox) is transient.
        if (signal.aborted) throw e
        if (!isTransient(e) || n === attempts) throw e
        await new Promise((r) => setTimeout(r, 400 * n))
      }
    }
    throw last
  }

  const saveFolders = async (list: LinkedFolder[]) => {
    dbxFoldersRef.current = list; setDbxFolders(list)
    await DB.kvSet('dropboxFolders', list)
  }

  const connectDropbox = useCallback(async () => {
    const key = settingsRef.current.dropboxAppKey || ENV_DROPBOX_KEY
    if (!key) { toast('Add your Dropbox app key first', 'error'); return }
    setDbxConnecting(true)
    try {
      const s = await startDropboxAuth(key) // web: navigates away to dropbox.com
      if (!s) return
      let session = s
      const c = new DropboxClient(key, s, (n) => { session = n })
      try { const a = await c.account(); session = { ...c.session, name: a.name, email: a.email, accountId: a.accountId } } catch { /* no account scope */ }
      await DB.kvSet('dropboxSession', session)
      applyDropboxSession(session, key)
      toast('Dropbox connected', 'ok')
    } catch (e: any) {
      toast(e?.message || 'Dropbox sign-in failed', 'error')
    } finally {
      setDbxConnecting(false)
    }
  }, [toast])

  const disconnectDropbox = useCallback(async () => {
    dropboxAbortRef.current?.abort()
    const c = dbxClientRef.current
    await Remote.flush().catch(() => {})
    applyDropboxSession(null, '')
    await DB.kvSet('dropboxSession', null)
    void c?.revoke()
    toast('Dropbox disconnected. Your tags stay in Dropbox.')
  }, [toast])

  /** small preview for the Dropbox picker (lazy, at most 4 requests at once, cached per file) */
  const pickerThumbs = useRef(new Map<string, Promise<string | null>>())
  const pickerQ = useRef({ active: 0, wait: [] as (() => void)[] })
  const dropboxThumb = useCallback((f: { id: string; path: string; rev?: string }) => {
    const key = f.id + '@' + (f.rev ?? '')
    let pr = pickerThumbs.current.get(key)
    if (!pr) {
      pr = (async () => {
        const c = dbxClientRef.current; if (!c) return null
        const q = pickerQ.current
        if (q.active >= 4) await new Promise<void>((r) => q.wait.push(r))
        q.active++
        try { const b = await c.preview(f, 'w256h256'); return b ? URL.createObjectURL(b) : null }
        finally { q.active--; q.wait.shift()?.() }
      })()
      pickerThumbs.current.set(key, pr)
      pr.then((u) => { if (!u) pickerThumbs.current.delete(key) })
    }
    return pr
  }, [])
  const listDropbox = useCallback(async (path: string) => {
    const c = dbxClientRef.current
    if (!c) throw new Error('Dropbox is not connected')
    const all = await c.listFolder(path)
    return all.filter((e) => !e.pathLower.startsWith('/.photo-tagger') && (e.kind === 'folder' || isDropboxMedia(e.name)))
      .sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name, undefined, { numeric: true }) : x.kind === 'folder' ? -1 : 1))
  }, [])

  /** Ingest one file (same rules as the queue runner) without touching the job done counter. */
  const ingestOneFile = useCallback(async (file: File, source: Photo['source'], dropbox?: DropboxRef) => {
    bumpJob({ label: `Processing ${file.name}` })
    try {
      const prep = await prepare(file, source, settingsRef.current, dropbox)
      const same = photosRef.current.find((p) => p.contentHash && p.contentHash === prep.contentHash)
        ?? nearRef.current.find((n) => n.prep?.contentHash === prep.contentHash)
      if (same) return 'duplicate' as const
      const near = nearestPhash(prep.photo.phash!, photosRef.current, settingsRef.current.dupeThreshold)
      if (near) {
        const match = photosRef.current.find((p) => p.id === near.id)!
        ingestPrepRef.current.set(prep.photo.id, prep)
        setNearBoth([...nearRef.current, {
          kind: 'ingest', id: prep.photo.id, name: prep.photo.name,
          matchId: match.id, matchName: match.name, distance: near.distance, prep,
        }])
        return 'near' as const
      }
      await finishPhoto(prep)
      return 'added' as const
    } catch (e: any) {
      return 'error' as const
    }
  }, [finishPhoto])

  /** files Photo Tagger can import from a folder, in a stable order (by path) — metadata only */
  const dropboxFolderFiles = useCallback(async (path: string, recursive: boolean) => {
    const c = dbxClientRef.current
    if (!c) throw new Error('Dropbox is not connected')
    const all = await c.listFolder(path, { recursive })
    // 1.0.33: files deleted with Delete from Dropbox (or still being deleted) are never offered by folder adds again
    return (all.filter((e) => e.kind === 'file' && isDropboxMedia(e.name) && !e.pathLower.startsWith('/.photo-tagger') && !Remote.isTrashedFile(e.id)) as DropboxFile[])
      .sort((a, b) => (a.pathLower < b.pathLower ? -1 : a.pathLower > b.pathLower ? 1 : 0))
  }, [])
  const dropboxFolderProgress = useCallback(async (path: string, recursive: boolean): Promise<FolderProgress> => {
    const files = await dropboxFolderFiles(path, recursive)
    const lib = new Set(photosRef.current.map((p) => p.dropbox?.id).filter(Boolean) as string[])
    const sk = skippedFiles()
    let inLibrary = 0, skipped = 0
    for (const f of files) { if (lib.has(f.id)) inLibrary++; else if (sk[f.id]) skipped++ }
    return { path, recursive, total: files.length, inLibrary, skipped, remaining: files.length - inLibrary - skipped }
  }, [dropboxFolderFiles])

  const processDropbox = useCallback(async (targets: LinkedFolder[], picked?: DropboxFile[], opts: { skipKnown?: boolean; run?: { path: string; recursive: boolean }; confirmed?: boolean; order?: DropboxAddOrder } = {}) => {
    const c = dbxClientRef.current
    if (!c) { toast('Connect Dropbox first (Settings → Dropbox)', 'error'); return }
    if (dropboxAbortRef.current) { toast('A Dropbox job is already running'); return }
    if (!opts.confirmed && !(await confirmFirstImport())) return
    if (dropboxAbortRef.current) { toast('A Dropbox job is already running'); return }
    const ac = new AbortController()
    dropboxAbortRef.current = ac
    setJobBoth({ label: picked ? 'Preparing selected Dropbox photos…' : 'Listing Dropbox folder…', total: 0, done: 0, failed: 0, cancellable: true })
    try {
      // Remember the folder(s) so Refresh finds new files later (hand-picked files never link their folder)
      if (!picked) {
      const linked = [...dbxFoldersRef.current]
      for (const t of targets) {
        const i = linked.findIndex((f) => f.path.toLowerCase() === t.path.toLowerCase())
        if (i >= 0) linked[i] = { ...linked[i], recursive: t.recursive || linked[i].recursive }
        else linked.push({ path: t.path, recursive: t.recursive })
      }
      await saveFolders(linked)
      }
      const seen = new Set<string>()
      for (const p of photosRef.current) if (p.dropbox?.id) seen.add(p.dropbox.id)
      const known = opts.skipKnown ? skippedFiles() : {}
      for (const n of nearRef.current) if (n.prep?.photo.dropbox?.id) seen.add(n.prep.photo.dropbox.id)
      const files: DropboxFile[] = []
      const alreadyIds: string[] = []
      let already = 0
      const sources: (() => Promise<DropboxEntry[]>)[] = picked ? [async () => picked] : targets.map((t) => () => c.listFolder(t.path, { recursive: t.recursive, signal: ac.signal }))
      for (const src of sources) {
        const entries = await src()
        for (const e of entries) {
          if (e.kind !== 'file' || !isDropboxMedia(e.name) || e.pathLower.startsWith('/.photo-tagger')) continue
          if (seen.has(e.id)) { already++; alreadyIds.push(e.id); continue }
          if (known[e.id]) continue
          // 1.0.33: deleted with Delete from Dropbox — Refresh / folder adds never bring it back; picking it on purpose does
          if (Remote.isTrashedFile(e.id)) { if (!picked) continue; Remote.liftTrashedFile(e.id) }
          seen.add(e.id); files.push(e)
        }
      }
      // deterministic order (name, or oldest/newest first — 1.0.30) so "Add next …" is predictable
      files.splice(0, files.length, ...orderDropboxFiles(files, opts.order ?? 'name'))
      // remember a single-folder run so an interrupted import can be offered again on next open (one tiny record)
      const run = opts.run ?? (!picked && targets.length === 1 ? { path: targets[0].path, recursive: targets[0].recursive } : null)
      if (run && files.length) setRunRecord({ ...run, at: Date.now() })
      // Pick up Dropbox tags added since the last visit (no re-download / re-tagging needed)
      if (alreadyIds.length) {
        const dset = new Set(alreadyIds)
        syncFromRemote(await Remote.importNativeTags(photosRef.current.filter((p) => p.dropbox && dset.has(p.dropbox.id)).map((p) => p.id)))
      }
      if (!files.length) {
        dropboxAbortRef.current = null
        setJobBoth(null)
        toast(already ? `No new photos — ${already} already in your library` : 'No images in this folder', 'ok')
        await saveFolders(dbxFoldersRef.current.map((f) => targets.some((t) => t.path.toLowerCase() === f.path.toLowerCase()) ? { ...f, lastSync: Date.now() } : f))
        return
      }
      // Large imports run in batches: tag a batch, wait until its tags are saved to Dropbox, verify them, then go on (1.0.27)
      const size = Math.max(10, Math.min(500, Math.round(settingsRef.current.dropboxBatchSize || 100)))
      const batches: DropboxFile[][] = []
      for (let k = 0; k < files.length; k += size) batches.push(files.slice(k, k + size))
      const multi = batches.length > 1
      let batchNo = 0, batchDone = 0, batchLen = 0
      const tagLabel = (name?: string) => multi ? `Batch ${batchNo} of ${batches.length} · tagging ${batchDone} of ${batchLen}` : name ? `Tagging from Dropbox · ${name}` : 'Tagging from Dropbox…'
      setJobBoth({ label: multi ? `Batch 1 of ${batches.length} · tagging 0 of ${batches[0].length}` : 'Tagging from Dropbox…', total: files.length, done: 0, failed: 0, cancellable: true })
      let done = 0, failed = 0, imported = 0, verifyProblems = 0
      const noPreview: string[] = []
      for (const batch of batches) {
        if (ac.signal.aborted) break
        batchNo++; batchDone = 0; batchLen = batch.length
        let next = 0
        const worker = async () => {
          while (true) {
            if (ac.signal.aborted) return
            const i = next++
            if (i >= batch.length) return
            const f = batch[i]
            bumpJob({ label: tagLabel(f.name), done, failed })
            try {
              // Photos: original bytes live only in memory for this step, then are dropped.
              // Videos: only Dropbox's preview frame is used — the movie is never downloaded.
              let file: File
              if (isDropboxVideo(f.name)) {
                const frame = await c.preview(f, 'w2048h1536')
                if (!frame) { noPreview.push(f.name); markSkipped(f.id, 'no preview'); done++; batchDone++; bumpJob({ label: multi ? tagLabel() : `No preview yet · ${f.name}`, done, failed }); continue }
                file = new File([frame], f.name, { type: 'image/jpeg' })
              } else file = await downloadWithRetry(c, f, ac.signal)
              const result = await ingestOneFile(file, 'dropbox', { id: f.id, path: f.path, rev: f.rev, contentHash: f.contentHash })
              if (result === 'error') failed++
              else imported++
              if (result === 'duplicate') markSkipped(f.id, 'duplicate')
              if (result === 'added') {
                const np = photosRef.current.find((p) => p.dropbox?.id === f.id)
                if (np) syncFromRemote(await Remote.importNativeTags([np.id]))
              }
              done++; batchDone++
              bumpJob({ label: tagLabel(f.name), done, failed })
            } catch (e: any) {
              if (e?.name === 'AbortError' || ac.signal.aborted) return
              failed++; done++; batchDone++
              bumpJob({ label: tagLabel(), done, failed })
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(3, batch.length) }, () => worker()))
        if (ac.signal.aborted) break
        // wait for this batch's Dropbox saves (the 1.0.26 queue) — the next batch starts only after they landed or were listed as failed
        const ids = new Set(batch.map((f) => f.id))
        const batchPhotos = photosRef.current.filter((p) => p.dropbox && ids.has(p.dropbox.id))
        const pre = multi ? `Batch ${batchNo} of ${batches.length} · ` : ''
        try {
          bumpJob({ label: `${pre}saving tags to Dropbox…` })
          void Remote.flush(false)
          await Remote.waitForSaved(batchPhotos.map((p) => p.id), ac.signal)
          bumpJob({ label: `${pre}verifying…` })
          verifyProblems += Remote.reportVerifyProblems(await Remote.verifyDropboxTags(batchPhotos.map((p) => photosRef.current.find((x) => x.id === p.id) ?? p)))
        } catch (e: any) {
          if (e?.name === 'AbortError' || ac.signal.aborted) break
          toast(`Could not verify batch ${batchNo}: ${e?.message || e}`, 'error')
        }
      }
      if (noPreview.length) toast(`${noPreview.length} video(s) skipped — Dropbox has no preview frame for them yet (the video isn't downloaded to tag it). Try again later: ${noPreview.slice(0, 3).join(', ')}${noPreview.length > 3 ? '…' : ''}`, 'error')
      dropboxAbortRef.current = null
      const cancelled = ac.signal.aborted
      setRunRecord(null) // finished or cancelled on purpose: nothing to offer next time
      setJobBoth({ label: cancelled ? 'Cancelled' : 'Done', total: files.length, done: cancelled ? files.length : done, failed, cancellable: false })
      if (!cancelled) await saveFolders(dbxFoldersRef.current.map((f) => targets.some((t) => t.path.toLowerCase() === f.path.toLowerCase()) ? { ...f, lastSync: Date.now() } : f))
      if (cancelled) {
        if (!imported) toast('Cancelled — nothing had finished yet')
        else toast(`Cancelled — ${imported} photo(s) kept in your library`, 'ok')
      } else if (failed > 0) {
        toast(`Tagged ${imported} photo(s) from Dropbox · ${failed} could not be read`, imported ? 'info' : 'error')
      } else {
        toast(`Tagged ${imported} new photo(s) from Dropbox${already ? ` · ${already} already in library` : ''}${multi ? ` in ${batches.length} batches` : ''}${verifyProblems ? ` · ${verifyProblems} need attention (see the Dropbox save list)` : ' · tags verified in Dropbox'}`, verifyProblems ? 'info' : 'ok')
      }
      endJob()
    } catch (e: any) {
      dropboxAbortRef.current = null
      setJobBoth(null)
      if (e?.name !== 'AbortError') toast(e?.message || 'Dropbox failed', 'error')
    }
  }, [ingestOneFile, toast, confirmFirstImport])

  const processDropboxFolder = useCallback((path: string, recursive: boolean) => processDropbox([{ path, recursive }]), [processDropbox])
  /** tag only these hand-picked files (same pipeline; the folder is not linked for Refresh) */
  const processDropboxFiles = useCallback((files: DropboxFile[]) => processDropbox([], files), [processDropbox])
  const refreshDropbox = useCallback(async () => {
    if (!dbxFoldersRef.current.length) { toast('No Dropbox folders linked yet — open From Dropbox and tag a folder'); return }
    await processDropbox(dbxFoldersRef.current)
  }, [processDropbox, toast])
  const addNextDropboxBatch = useCallback(async (path: string, recursive: boolean, count?: number) => {
    if (dropboxAbortRef.current) { toast('A Dropbox job is already running'); return }
    if (!(await confirmFirstImport())) return
    try {
      const files = await dropboxFolderFiles(path, recursive)
      const lib = new Set(photosRef.current.map((p) => p.dropbox?.id).filter(Boolean) as string[])
      const sk = skippedFiles()
      const order = settingsRef.current.dropboxAddOrder ?? 'name'
      const rest = orderDropboxFiles(files.filter((f) => !lib.has(f.id) && !sk[f.id]), order)
      if (!rest.length) { toast('All photos in this folder are already in your library', 'ok'); return }
      // how many to add (count picker, 1.0.30); the batch size stays the per-round save/verify limit inside processDropbox
      const n = Math.max(1, Math.round(count ?? settingsRef.current.dropboxBatchSize ?? 100))
      await processDropbox([], rest.slice(0, n), { skipKnown: true, run: { path, recursive }, confirmed: true, order })
    } catch (e: any) { toast(e?.message || 'Dropbox failed', 'error') }
  }, [dropboxFolderFiles, processDropbox, toast, confirmFirstImport])
  const addAllRemainingDropbox = useCallback((path: string, recursive: boolean) => processDropbox([{ path, recursive }], undefined, { skipKnown: true, order: settingsRef.current.dropboxAddOrder ?? 'name' }), [processDropbox])
  const addDropboxSelection = useCallback(async (files: DropboxFile[], folders: string[] = [], recursive = false) => {
    if (dropboxAbortRef.current) { toast('A Dropbox job is already running'); return }
    if (!(await confirmFirstImport())) return
    try {
      const all = new Map(files.map((f) => [f.id, f]))
      // picked subfolders: their photos/videos (and their subfolders' when Include subfolders is on) — metadata listing only
      for (const path of folders) for (const f of await dropboxFolderFiles(path, recursive)) all.set(f.id, f)
      const lib = new Set(photosRef.current.map((p) => p.dropbox?.id).filter(Boolean) as string[])
      const list = [...all.values()].filter((f) => !lib.has(f.id))
      if (!list.length) { toast('Everything you picked is already in your library', 'ok'); return }
      await processDropbox([], list, { confirmed: true, order: settingsRef.current.dropboxAddOrder ?? 'name' })
    } catch (e: any) { toast(e?.message || 'Dropbox failed', 'error') }
  }, [dropboxFolderFiles, processDropbox, toast, confirmFirstImport])
  const forgetDropboxFolder = useCallback(async (path: string) => {
    await saveFolders(dbxFoldersRef.current.filter((f) => f.path !== path))
  }, [])

  // ---------- editing ----------
  const updatePhotos = useCallback(async (ids: string[], fn: (p: Photo) => Photo) => {
    const set = new Set(ids)
    const next = photosRef.current.filter((p) => set.has(p.id)).map(fn)
    await Promise.all(next.map((p) => DB.putPhoto(p)))
    const byId = new Map(next.map((p) => [p.id, p]))
    setPhotosBoth((all) => all.map((p) => byId.get(p.id) ?? p))
  }, [setPhotosBoth])

  const addTags = useCallback(
    (ids: string[], names: string[]) => updatePhotos(ids, (p) => {
      const n2 = names.reduce((a, n) => addTag(a, n, 'manual'), p)
      // adding a tag again in Photo Tagger lifts a Dropbox-side deletion
      const back = new Set(names.map(Remote.toDropboxTag))
      return n2.dropboxRemoved?.some((t) => back.has(t)) ? { ...n2, dropboxRemoved: n2.dropboxRemoved.filter((t) => !back.has(t)) } : n2
    }),
    [updatePhotos],
  )
  const removeTags = useCallback(
    (ids: string[], names: string[]) => updatePhotos(ids, (p) => names.reduce((a, n) => removeTag(a, normTag(n)), p)),
    [updatePhotos],
  )
  const deletePhotos = useCallback(async (ids: string[]) => {
    await DB.deletePhotos(ids)
    const set = new Set(ids)
    setPhotosBoth((all) => all.filter((p) => !set.has(p.id)))
  }, [setPhotosBoth])
  const trashDropboxPhotos = useCallback(async (ids: string[]) => {
    await DB.trashDropboxPhotos(ids)
    const set = new Set(ids)
    setPhotosBoth((all) => all.filter((p) => !set.has(p.id)))
  }, [setPhotosBoth])

  // ---------- (re)tagging ----------
  const runJob = async (label: string, total: number, fn: (step: (name: string) => void) => Promise<void>) => {
    setJobBoth({ label, total, done: 0, failed: 0 })
    try {
      await fn((name) => bumpJob({ label: `${label} ${name}`, done: (jobRef.current?.done ?? 0) + 1 }))
    } finally {
      bumpJob({ done: total })
      endJob()
    }
  }

  const syncCustomEmbeddings = useCallback(async () => {
    const missing = [...new Set(customRef.current.map((c) => c.prompt).filter((pr) => !customEmb.current.has(pr)))]
    if (!missing.length) return
    await ensureModel()
    const es = await ml.embedTexts(missing)
    missing.forEach((m, i) => customEmb.current.set(m, es[i]))
    await DB.kvSet('customEmb', Object.fromEntries([...customEmb.current].map(([k, v]) => [k, Array.from(v)])))
  }, [ensureModel])

  /** CLIP embedding for a photo: stored one, else from its view image, else (Dropbox) a temporary in-memory download of the original */
  const embeddingFor = useCallback(async (p: Photo): Promise<Float32Array> => {
    let blob: Blob | undefined = await DB.getBlob('views', p.id)
    if (!blob && p.dropbox) {
      if (isDropboxVideo(p.name)) throw new Error("Dropbox has no preview frame for this video yet (videos are tagged from the preview only)")
      blob = await fetchDropboxOriginal(p)
      if (!blob) throw new Error('could not download it from Dropbox')
    }
    if (!blob) throw new Error('no image is available for it')
    await ensureModel()
    const px = await pixelsFromBlob(blob) // bytes are dropped after this
    const e = await ml.embedImage(px.rgb, px.width, px.height)
    await DB.putEmbedding(p.id, e)
    return e
  }, [ensureModel])

  const retagAll = useCallback(async () => {
    ml.resetFailed()
    const s = settingsRef.current
    try {
      await syncCustomEmbeddings()
      const embs = await DB.allEmbeddings()
      // pick up tags added/removed in Dropbox first so re-tagging never overwrites them
      if (photosRef.current.some((p) => p.dropbox)) syncFromRemote(await Remote.importNativeTags())
      const all = photosRef.current.slice()
      const failedNames: string[] = []
      await runJob('Re-tagging', all.length, async (step) => {
        for (const p0 of all) {
          // refresh quality flags from stored measurements (thresholds may have changed)
          const q = qualityFlags(p0.quality.sharpness, p0.quality.brightness, s)
          // recompute exif + quality tags from the current Detection-list toggles (1.0.23)
          let p: Photo = applyMetaTags({ ...p0, quality: q }, s.disabledMetaTags ?? [])
          let e = embs.get(p.id)
          if (!e) { try { e = await embeddingFor(p) } catch { e = undefined } }
          if (e) await tagWithEmbedding(p, e)
          else { await persist(p); failedNames.push(p.name) }
          step(p.name)
        }
      })
      if (failedNames.length) toast(`Library re-tagged — ${failedNames.length} photo(s) could not be re-scored (no image available): ${failedNames.slice(0, 3).join(', ')}${failedNames.length > 3 ? '…' : ''}`, 'error')
      else toast('Library re-tagged', 'ok')
    } catch (e: any) {
      toast(`Re-tagging failed: ${e.message}`, 'error')
    }
  }, [embeddingFor, persist, syncCustomEmbeddings, tagWithEmbedding, toast])

  const retagPhoto = useCallback(async (id: string) => {
    ml.resetFailed()
    const name = photosRef.current.find((x) => x.id === id)?.name ?? 'photo'
    setJobBoth({ label: `Re-tagging ${name}…`, total: 1, done: 0, failed: 0 })
    let ok = false
    try {
      if (photosRef.current.find((x) => x.id === id)?.dropbox) syncFromRemote(await Remote.importNativeTags([id]))
      const p = photosRef.current.find((x) => x.id === id)
      if (!p) throw new Error('photo not found')
      await syncCustomEmbeddings()
      const s = settingsRef.current
      const p1 = photosRef.current.find((x) => x.id === id) ?? p
      const meta = applyMetaTags({ ...p1, quality: qualityFlags(p1.quality.sharpness, p1.quality.brightness, s) }, s.disabledMetaTags ?? [])
      const e = (await DB.allEmbeddings()).get(id) ?? (await embeddingFor(meta))
      await tagWithEmbedding(meta, e)
      ok = true
      toast(`Re-tagged ${name}`, 'ok')
    } catch (err: any) {
      toast(`Re-tagging ${name} failed: ${err?.message || err}`, 'error')
    } finally {
      setJobBoth({ label: ok ? `Re-tagged ${name}` : `Re-tagging ${name} failed`, total: 1, done: 1, failed: ok ? 0 : 1 })
      endJob()
    }
  }, [embeddingFor, syncCustomEmbeddings, tagWithEmbedding, toast])

  const retryPending = useCallback(async () => {
    const pend = photosRef.current.filter((p) => p.status === 'pending')
    if (!pend.length) return
    modelFailed.current = false
    ml.resetFailed()
    try {
      await runJob('Tagging', pend.length, async (step) => {
        for (const p of pend) {
          const v = await DB.getBlob('views', p.id)
          if (v) {
            await ensureModel()
            const px = await pixelsFromBlob(v)
            const e = await ml.embedImage(px.rgb, px.width, px.height)
            await DB.putEmbedding(p.id, e)
            await tagWithEmbedding(p, e)
          }
          step(p.name)
        }
      })
    } catch (e: any) {
      reportTaggingFailure(e)
    }
  }, [ensureModel, reportTaggingFailure, tagWithEmbedding])

  const preloadModel = useCallback(async () => {
    ml.resetFailed()
    try { await ensureModel(); modelFailed.current = false; toast('Tagging model ready', 'ok') } catch (e: any) { toast(`Model download failed: ${e.message}`, 'error') }
  }, [ensureModel, toast])

  // ---------- settings & vocabulary ----------
  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch }
    settingsRef.current = next
    setSettings(next)
    await DB.kvSet('settings', next)
  }, [])
  const answerPreImport = useCallback((choice: 'proceed' | 'review' | 'cancel', dontAskAgain: boolean) => {
    if (dontAskAgain) void saveSettings({ askBeforeFirstImport: false })
    const res = preImportRef.current
    preImportRef.current = null
    setPreImportAsk(false)
    res?.(choice === 'proceed')
  }, [saveSettings])

  const saveCustom = async (c: CustomLabel[]) => {
    customRef.current = c; setCustom(c)
    await DB.kvSet('custom', c)
  }

  const addCustomLabel = useCallback(async (label: string, prompt?: string) => {
    const l = normTag(label)
    if (!l) return
    const pr = (prompt ?? '').trim() || `a photo of ${l}`
    if (customRef.current.some((c) => c.label === l)) { toast(`"${l}" already exists`); return }
    await saveCustom([...customRef.current, { id: `custom:${l}`, label: l, prompt: pr, group: 'Custom' }])
    try {
      await syncCustomEmbeddings()
      toast(`Added "${l}". Use "Re-tag library" to apply it to existing photos.`, 'ok')
    } catch (e: any) {
      toast(`Couldn't download the text model needed for custom labels: ${e.message}`, 'error')
    }
  }, [syncCustomEmbeddings, toast])

  const removeCustomLabel = useCallback(async (id: string) => {
    await saveCustom(customRef.current.filter((c) => c.id !== id))
  }, [])

  const toggleLabel = useCallback(async (id: string, on: boolean) => {
    const d = new Set(settingsRef.current.disabledLabels)
    if (on) d.delete(id); else d.add(id)
    await saveSettings({ disabledLabels: [...d] })
  }, [saveSettings])

  const toggleMetaTag = useCallback(async (id: string, on: boolean) => {
    const d = new Set(settingsRef.current.disabledMetaTags ?? [])
    if (on) d.delete(id); else d.add(id)
    await saveSettings({ disabledMetaTags: [...d] })
  }, [saveSettings])

  const setAllAutoTags = useCallback(async (mode: 'off' | 'on' | 'restore') => {
    const s = settingsRef.current
    if (mode === 'off') {
      await saveSettings({
        autoTagsBackup: { disabledLabels: [...s.disabledLabels], disabledMetaTags: [...(s.disabledMetaTags ?? [])] },
        disabledLabels: [...new Set([...s.disabledLabels, ...DEFAULT_LABELS.map((l) => l.id), ...customRef.current.map((c) => c.id)])],
        disabledMetaTags: META_TAGS.map((m) => m.id),
      })
    } else if (mode === 'restore' && s.autoTagsBackup) {
      await saveSettings({ disabledLabels: s.autoTagsBackup.disabledLabels, disabledMetaTags: s.autoTagsBackup.disabledMetaTags, autoTagsBackup: undefined })
    } else {
      await saveSettings({ disabledLabels: [], disabledMetaTags: [], autoTagsBackup: undefined })
    }
  }, [saveSettings])

  const resetVocabulary = useCallback(async () => {
    await saveCustom([])
    await saveSettings({ disabledLabels: [], disabledMetaTags: [] })
  }, [saveSettings])

  // ---------- export / import ----------
  const exportData = useCallback((kind: 'json' | 'csv', ids?: string[]) => {
    const set = ids ? new Set(ids) : null
    const list = photosRef.current.filter((p) => !set || set.has(p.id))
    const stamp = new Date().toISOString().slice(0, 10)
    if (kind === 'json') download(`photo-tags-${stamp}.json`, toJSON(list, settingsRef.current, customRef.current), 'application/json')
    else download(`photo-tags-${stamp}.csv`, toCSV(list), 'text/csv')
  }, [])

  const importTags = useCallback(async (file: File) => {
    try {
      const res = parseImport(file.name, await file.text())
      let updated = 0, missing = 0
      const byName = new Map<string, Photo[]>()
      for (const p of photosRef.current) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
      const changes = new Map<string, Photo>()
      for (const e of res.entries) {
        const c = byName.get(e.name) ?? []
        const match = c.find((p) => e.size != null && p.size === e.size) ?? (c.length === 1 ? c[0] : undefined)
        if (!match) { missing++; continue }
        let p = changes.get(match.id) ?? match
        for (const t of e.tags) {
          if (t.source === 'exif' || t.source === 'quality') continue // those are recomputed from the image itself
          // person tags come from confirmed faces on this device; imported ones become ordinary tags
          if (!p.tags.some((x) => x.name === t.name)) p = addTag(p, t.name, t.source === 'person' ? 'manual' : t.source, t.score)
        }
        for (const r of e.rejected ?? []) if (!p.rejected.includes(r)) p = { ...p, rejected: [...p.rejected, r] }
        changes.set(match.id, p)
        updated++
      }
      await Promise.all([...changes.values()].map((p) => DB.putPhoto(p)))
      setPhotosBoth((all) => all.map((p) => changes.get(p.id) ?? p))
      if (res.vocabulary) {
        const known = new Set(customRef.current.map((c) => c.id))
        const add = (res.vocabulary.custom ?? []).filter((c) => !known.has(c.id))
        if (add.length) { await saveCustom([...customRef.current, ...add]); void syncCustomEmbeddings().catch(() => {}) }
        const d = new Set([...settingsRef.current.disabledLabels, ...(res.vocabulary.disabled ?? [])])
        await saveSettings({ disabledLabels: [...d] })
      }
      toast(`Imported tags for ${updated} photo(s)${missing ? `; ${missing} not in your library` : ''}`, missing && !updated ? 'error' : 'ok')
    } catch (e: any) {
      toast(e.message || 'Import failed', 'error')
    }
  }, [saveSettings, setPhotosBoth, syncCustomEmbeddings, toast])

  const clearEverything = useCallback(async () => {
    await DB.clearAll()
    Remote.clearPersistedQueue()
    customEmb.current = new Map()
    photosRef.current = []; setPhotos([])
    customRef.current = []; setCustom([])
    applyDropboxSession(null, '')
    { const fresh = await initialSettings(null, 0, 0); settingsRef.current = fresh; setSettings(fresh) }
    dbxFoldersRef.current = []; setDbxFolders([])
    toast('All local data deleted', 'ok')
  }, [toast])

  const value = useMemo<Library>(() => ({
    ready, photos, settings, custom, job, model, toasts,
    pendingCount: photos.filter((p) => p.status === 'pending').length,
    dropboxKey,
    dropbox: { connected: !!dbxSession, account: dbxSession?.name || dbxSession?.email || '', folders: dbxFolders, connecting: dbxConnecting },
    connectDropbox, disconnectDropbox, listDropbox, dropboxThumb, processDropboxFolder, processDropboxFiles, preImportAsk, answerPreImport, refreshDropbox, dropboxFolderProgress, addNextDropboxBatch, addAllRemainingDropbox, dropboxFolderFiles, addDropboxSelection, forgetDropboxFolder,
    addFiles, cancelDropboxDownload, updatePhotos, addTags, removeTags, deletePhotos, trashDropboxPhotos, retagAll, retagPhoto, pullDropboxTags, retryPending,
    saveSettings, addCustomLabel, removeCustomLabel, toggleLabel, toggleMetaTag, resetVocabulary, setAllAutoTags, exportData, importTags,
    clearEverything, toast, preloadModel, setAfterIngest,
    nearDupes, resolveNearDupe, resolveAllNearDupes, findDuplicates, dismissDupePair,
    folderSupported: canPickFolder, folderName, chooseSaveFolder, clearSaveFolder: clearSaveFolderFn,
    libraryPath, isDesktop: DB.isDesktop(), chooseLibraryFolder, changeLibraryFolder, portable, useLibraryBesideApp,
    savePhotosToDisk, downloadPhotosZip,
  }), [ready, photos, settings, custom, job, model, toasts, dropboxKey, dbxSession, dbxFolders, dbxConnecting, connectDropbox, disconnectDropbox, listDropbox, dropboxThumb, processDropboxFolder, processDropboxFiles, preImportAsk, answerPreImport, refreshDropbox, dropboxFolderProgress, addNextDropboxBatch, addAllRemainingDropbox, dropboxFolderFiles, addDropboxSelection, forgetDropboxFolder, addFiles, cancelDropboxDownload, updatePhotos, addTags, removeTags,
    deletePhotos, trashDropboxPhotos, retagAll, retagPhoto, pullDropboxTags, retryPending, saveSettings, addCustomLabel, removeCustomLabel, toggleLabel, toggleMetaTag, resetVocabulary, setAllAutoTags, exportData,
    importTags, clearEverything, toast, preloadModel, setAfterIngest, nearDupes, resolveNearDupe, resolveAllNearDupes, findDuplicates,
    dismissDupePair, folderName, chooseSaveFolder, clearSaveFolderFn, savePhotosToDisk, downloadPhotosZip, libraryPath, chooseLibraryFolder, changeLibraryFolder, portable, useLibraryBesideApp])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export type { Tag }
