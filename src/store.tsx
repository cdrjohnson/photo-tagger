import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as DB from './storage'
import { ml, type ModelProgress, type ModelState } from './ml/client'
import { applyAutoTags, buildVocab, scoreTags, type VocabEntry } from './tagging'
import { addTag, exifAndQualityTags, normTag, removeTag } from './tags'
import { fingerprint, hashesFromBlob, isImageFile, pixelsFromBlob, prepare, type Prepared } from './ingest'
import { nearestPhash } from './hashes'
import { buildZip, canPickFolder, clearSavedFolder, downloadBlob, ensurePermission, getSavedFolder, pickFolder, saveOneToFolder, saveToFolder, type DirHandle } from './folderSave'
import { qualityFlags } from './imageUtils'
import { chooseFromDropbox, downloadChoice, ENV_DROPBOX_KEY, isDropboxReady, loadDropbox } from './dropbox'
import { parseImport, toCSV, toJSON, download } from './exportImport'
import { DEFAULT_SETTINGS, type CustomLabel, type Photo, type Settings, type Tag } from './types'

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
  importFromDropbox(): Promise<'no-key' | 'ok'>
  /** Abort remaining Dropbox downloads; already-finished files are still tagged. */
  cancelDropboxDownload(): void
  updatePhotos(ids: string[], fn: (p: Photo) => Photo): Promise<void>
  addTags(ids: string[], names: string[]): Promise<void>
  removeTags(ids: string[], names: string[]): Promise<void>
  deletePhotos(ids: string[]): Promise<void>
  retagAll(): Promise<void>
  retagPhoto(id: string): Promise<void>
  retryPending(): Promise<void>
  saveSettings(s: Partial<Settings>): Promise<void>
  addCustomLabel(label: string, prompt?: string): Promise<void>
  removeCustomLabel(id: string): Promise<void>
  toggleLabel(id: string, on: boolean): Promise<void>
  resetVocabulary(): Promise<void>
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
      const merged = { ...DEFAULT_SETTINGS, ...(s ?? {}) }
      if (desktop) merged.keepOriginals = true
      settingsRef.current = merged; setSettings(merged)
      customRef.current = c ?? []; setCustom(c ?? [])
      const embMap = new Map<string, Float32Array>()
      for (const [k, v] of Object.entries(ce ?? {})) embMap.set(k, v instanceof Float32Array ? v : Float32Array.from(v as number[]))
      customEmb.current = embMap
      photosRef.current = ps; setPhotos(ps)
      setReady(true)
      if (!desktop) navigator.storage?.persist?.().catch(() => {})
    })()
    ml.onProgress = (p) => setModel((m) => ({ ...m, phase: p.phase, loaded: p.loaded, total: p.total }))
    ml.onState = (state) => setModel((m) => ({ ...m, state, error: ml.error }))
  }, [])

  const dropboxKey = settings.dropboxAppKey || ENV_DROPBOX_KEY
  useEffect(() => {
    if (ready && dropboxKey) loadDropbox(dropboxKey).catch(() => {})
  }, [ready, dropboxKey])

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
      const merged = { ...DEFAULT_SETTINGS, ...(st ?? {}), keepOriginals: true }
      settingsRef.current = merged; setSettings(merged)
      customRef.current = c ?? []; setCustom(c ?? [])
      const embMap = new Map<string, Float32Array>()
      for (const [k, v] of Object.entries(ce ?? {})) embMap.set(k, v instanceof Float32Array ? v : Float32Array.from(v as number[]))
      customEmb.current = embMap
      photosRef.current = ps; setPhotos(ps)
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
      const merged = { ...DEFAULT_SETTINGS, ...(st ?? {}), keepOriginals: true }
      settingsRef.current = merged; setSettings(merged)
      customRef.current = c ?? []; setCustom(c ?? [])
      const embMap = new Map<string, Float32Array>()
      for (const [k, v] of Object.entries(ce ?? {})) embMap.set(k, v instanceof Float32Array ? v : Float32Array.from(v as number[]))
      customEmb.current = embMap
      photosRef.current = ps; setPhotos(ps)
      toast(`Library folder: ${path}`, 'ok')
    } catch (e: any) {
      toast(e?.message || 'Could not create library beside the app', 'error')
    }
  }, [toast])

  const cancelDropboxDownload = useCallback(() => {
    dropboxAbortRef.current?.abort()
  }, [])

  /** Ingest one file (same rules as the queue runner) without touching the job done counter. */
  const ingestOneFile = useCallback(async (file: File, source: Photo['source']) => {
    bumpJob({ label: `Processing ${file.name}` })
    try {
      const prep = await prepare(file, source, settingsRef.current)
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
      toast(`Could not read ${file.name}: ${e.message || 'unsupported image'}`, 'error')
      return 'error' as const
    }
  }, [finishPhoto, toast])

  const downloadChoiceWithRetry = async (c: { name: string; link: string; bytes: number }, signal: AbortSignal, attempts = 3) => {
    let last: unknown
    for (let n = 1; n <= attempts; n++) {
      // User cancel — never retry
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        return await downloadChoice(c, signal)
      } catch (e: any) {
        last = e
        // Abort from our Cancel button — stop. AbortError without user cancel (e.g. Firefox) is transient.
        if (signal.aborted) throw e
        const msg = String(e?.message || e)
        const status = Number(/Dropbox download failed \((\d+)\)/.exec(msg)?.[1] || 0)
        const transient = e?.name === 'AbortError' || e?.name === 'TypeError'
          || /failed to fetch|network|aborted|abort/i.test(msg)
          || status === 429 || status >= 500
        if (!transient || n === attempts) throw e
        await new Promise((r) => setTimeout(r, 400 * n))
      }
    }
    throw last
  }

  const importFromDropbox = useCallback(async () => {
    if (!dropboxKey) return 'no-key' as const
    // Dropbox.choose() must run on the same turn as the user click. Never await script load here.
    if (!isDropboxReady(dropboxKey)) {
      void loadDropbox(dropboxKey).catch((e: any) => toast(e?.message || 'Could not load Dropbox', 'error'))
      toast('Loading Dropbox… click From Dropbox again', 'info')
      return 'ok' as const
    }
    try {
      // Visible while Dropbox's own dialog is open (we cannot put a spinner inside it)
      setJobBoth({ label: 'Choose files in the Dropbox window…', total: 0, done: 0, failed: 0 })
      // choose() is invoked synchronously inside chooseFromDropbox — still on the click stack
      const chosen = await chooseFromDropbox()
      if (!chosen.length) {
        setJobBoth(null)
        return 'ok' as const
      }
      const ac = new AbortController()
      dropboxAbortRef.current = ac
      setJobBoth({ label: 'Downloading from Dropbox…', total: chosen.length, done: 0, failed: 0, cancellable: true })
      let next = 0
      let done = 0
      let failed = 0
      let imported = 0
      const concurrency = Math.min(3, chosen.length)
      const worker = async () => {
        while (true) {
          if (ac.signal.aborted) return
          const i = next++
          if (i >= chosen.length) return
          const c = chosen[i]
          bumpJob({ label: `Downloading from Dropbox · ${c.name}`, done, failed })
          try {
            // Download then immediately ingest — backpressure: only ~concurrency blobs in flight
            const file = await downloadChoiceWithRetry(c, ac.signal)
            // A completed download is always ingested (Cancel only stops remaining / in-flight fetches)
            bumpJob({ label: `Processing ${c.name}`, done, failed })
            const result = await ingestOneFile(file, 'dropbox')
            if (result === 'added' || result === 'near' || result === 'duplicate') imported++
            done++
            bumpJob({ label: `Downloading from Dropbox · ${c.name}`, done, failed })
          } catch (e: any) {
            if (e?.name === 'AbortError' || ac.signal.aborted) return
            failed++
            done++
            bumpJob({ label: `Downloading from Dropbox…`, done, failed })
            // no per-file toast — summary at the end
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()))
      dropboxAbortRef.current = null
      const cancelled = ac.signal.aborted
      setJobBoth({ label: cancelled ? 'Import cancelled' : 'Done', total: chosen.length, done, failed, cancellable: false })
      if (cancelled) {
        if (!imported) toast('Import cancelled — nothing had finished downloading yet')
        else toast(`Import cancelled — ${imported} photo(s) kept in your library`, 'ok')
      } else if (failed > 0) {
        toast(`Imported ${imported} photo(s) from Dropbox · ${failed} download(s) failed`, imported ? 'info' : 'error')
      }
      endJob()
    } catch (e: any) {
      dropboxAbortRef.current = null
      setJobBoth(null)
      toast(e.message || 'Dropbox import failed', 'error')
    }
    return 'ok' as const
  }, [dropboxKey, ingestOneFile, toast])

  // ---------- editing ----------
  const updatePhotos = useCallback(async (ids: string[], fn: (p: Photo) => Photo) => {
    const set = new Set(ids)
    const next = photosRef.current.filter((p) => set.has(p.id)).map(fn)
    await Promise.all(next.map((p) => DB.putPhoto(p)))
    const byId = new Map(next.map((p) => [p.id, p]))
    setPhotosBoth((all) => all.map((p) => byId.get(p.id) ?? p))
  }, [setPhotosBoth])

  const addTags = useCallback(
    (ids: string[], names: string[]) => updatePhotos(ids, (p) => names.reduce((a, n) => addTag(a, n, 'manual'), p)),
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

  const retagAll = useCallback(async () => {
    ml.resetFailed()
    const s = settingsRef.current
    try {
      await syncCustomEmbeddings()
      const embs = await DB.allEmbeddings()
      const all = photosRef.current.slice()
      await runJob('Re-tagging', all.length, async (step) => {
        for (const p0 of all) {
          // refresh quality flags from stored measurements (thresholds may have changed)
          const q = qualityFlags(p0.quality.sharpness, p0.quality.brightness, s)
          let p: Photo = { ...p0, quality: q, tags: [...p0.tags.filter((t) => t.source !== 'quality'), ...exifAndQualityTags({ ...p0, quality: q }).filter((t) => t.source === 'quality')] }
          let e = embs.get(p.id)
          if (!e) {
            const v = await DB.getBlob('views', p.id)
            if (v) {
              await ensureModel()
              const px = await pixelsFromBlob(v)
              e = await ml.embedImage(px.rgb, px.width, px.height)
              await DB.putEmbedding(p.id, e)
            }
          }
          if (e) await tagWithEmbedding(p, e)
          else await persist(p)
          step(p.name)
        }
      })
      toast('Library re-tagged', 'ok')
    } catch (e: any) {
      toast(`Re-tagging failed: ${e.message}`, 'error')
    }
  }, [ensureModel, persist, syncCustomEmbeddings, tagWithEmbedding, toast])

  const retagPhoto = useCallback(async (id: string) => {
    ml.resetFailed()
    const p = photosRef.current.find((x) => x.id === id)
    if (!p) return
    try {
      await syncCustomEmbeddings()
      let e = (await DB.allEmbeddings()).get(id)
      if (!e) {
        const v = await DB.getBlob('views', id)
        if (!v) return
        await ensureModel()
        const px = await pixelsFromBlob(v)
        e = await ml.embedImage(px.rgb, px.width, px.height)
        await DB.putEmbedding(id, e)
      }
      await tagWithEmbedding(p, e)
    } catch (err: any) {
      toast(`Tagging failed: ${err.message}`, 'error')
    }
  }, [ensureModel, syncCustomEmbeddings, tagWithEmbedding, toast])

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

  const resetVocabulary = useCallback(async () => {
    await saveCustom([])
    await saveSettings({ disabledLabels: [] })
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
    customEmb.current = new Map()
    photosRef.current = []; setPhotos([])
    settingsRef.current = DEFAULT_SETTINGS; setSettings(DEFAULT_SETTINGS)
    customRef.current = []; setCustom([])
    toast('All local data deleted', 'ok')
  }, [toast])

  const value = useMemo<Library>(() => ({
    ready, photos, settings, custom, job, model, toasts,
    pendingCount: photos.filter((p) => p.status === 'pending').length,
    dropboxKey,
    addFiles, importFromDropbox, cancelDropboxDownload, updatePhotos, addTags, removeTags, deletePhotos, retagAll, retagPhoto, retryPending,
    saveSettings, addCustomLabel, removeCustomLabel, toggleLabel, resetVocabulary, exportData, importTags,
    clearEverything, toast, preloadModel, setAfterIngest,
    nearDupes, resolveNearDupe, resolveAllNearDupes, findDuplicates, dismissDupePair,
    folderSupported: canPickFolder, folderName, chooseSaveFolder, clearSaveFolder: clearSaveFolderFn,
    libraryPath, isDesktop: DB.isDesktop(), chooseLibraryFolder, changeLibraryFolder, portable, useLibraryBesideApp,
    savePhotosToDisk, downloadPhotosZip,
  }), [ready, photos, settings, custom, job, model, toasts, dropboxKey, addFiles, importFromDropbox, cancelDropboxDownload, updatePhotos, addTags, removeTags,
    deletePhotos, retagAll, retagPhoto, retryPending, saveSettings, addCustomLabel, removeCustomLabel, toggleLabel, resetVocabulary, exportData,
    importTags, clearEverything, toast, preloadModel, setAfterIngest, nearDupes, resolveNearDupe, resolveAllNearDupes, findDuplicates,
    dismissDupePair, folderName, chooseSaveFolder, clearSaveFolderFn, savePhotosToDisk, downloadPhotosZip, libraryPath, chooseLibraryFolder, changeLibraryFolder, portable, useLibraryBesideApp])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export type { Tag }
