import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as DB from './db'
import { ml, type ModelProgress, type ModelState } from './ml/client'
import { applyAutoTags, buildVocab, scoreTags, type VocabEntry } from './tagging'
import { addTag, exifAndQualityTags, normTag, removeTag } from './tags'
import { fingerprint, isImageFile, pixelsFromBlob, prepare } from './ingest'
import { qualityFlags } from './imageUtils'
import { chooseFromDropbox, downloadChoice, ENV_DROPBOX_KEY, loadDropbox } from './dropbox'
import { parseImport, toCSV, toJSON, download } from './exportImport'
import { DEFAULT_SETTINGS, type CustomLabel, type Photo, type Settings, type Tag } from './types'

export interface Job { label: string; total: number; done: number; failed: number }
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

  const photosRef = useRef<Photo[]>([])
  const settingsRef = useRef(settings)
  const customRef = useRef(custom)
  const customEmb = useRef(new Map<string, Float32Array>())
  const queue = useRef<{ file: File; source: Photo['source'] }[]>([])
  const running = useRef(false)
  const jobRef = useRef<Job | null>(null)
  const modelFailed = useRef(false)

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
      const [ps, s, c, ce] = await Promise.all([
        DB.allPhotos(),
        DB.kvGet<Partial<Settings>>('settings'),
        DB.kvGet<CustomLabel[]>('custom'),
        DB.kvGet<Record<string, Float32Array>>('customEmb'),
      ])
      const merged = { ...DEFAULT_SETTINGS, ...(s ?? {}) }
      settingsRef.current = merged; setSettings(merged)
      customRef.current = c ?? []; setCustom(c ?? [])
      customEmb.current = new Map(Object.entries(ce ?? {}))
      photosRef.current = ps; setPhotos(ps)
      setReady(true)
      navigator.storage?.persist?.().catch(() => {})
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

  // ---------- ingest ----------
  const run = useCallback(async () => {
    if (running.current) return
    running.current = true
    modelFailed.current = false
    try {
      while (queue.current.length) {
        const item = queue.current.shift()!
        bumpJob({ label: `Processing ${item.file.name}` })
        try {
          const prep = await prepare(item.file, item.source, settingsRef.current)
          await DB.savePhotoWithBlobs(prep.photo, prep.blobs)
          setPhotosBoth((all) => [...all, prep.photo])
          if (!modelFailed.current) {
            try {
              await ensureModel()
              const emb = await ml.embedImage(prep.rgb, prep.rw, prep.rh)
              await DB.putEmbedding(prep.photo.id, emb)
              await tagWithEmbedding(prep.photo, emb)
            } catch (e: any) {
              modelFailed.current = true
              toast(`Tagging model unavailable: ${e.message}. Photos were added untagged – use "Retry tagging" when you're online.`, 'error')
            }
          }
        } catch (e: any) {
          bumpJob({ failed: (jobRef.current?.failed ?? 0) + 1 })
          toast(`Could not read ${item.file.name}: ${e.message || 'unsupported image'}`, 'error')
        }
        bumpJob({ done: (jobRef.current?.done ?? 0) + 1 })
      }
    } finally {
      running.current = false
      endJob()
    }
  }, [ensureModel, setPhotosBoth, tagWithEmbedding, toast])

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
    if (!fresh.length) return
    queue.current.push(...fresh.map((file) => ({ file, source })))
    const cur = jobRef.current
    setJobBoth({ label: '', total: (cur?.total ?? 0) + fresh.length, done: cur?.done ?? 0, failed: cur?.failed ?? 0 })
    void run()
  }, [run, toast])

  const importFromDropbox = useCallback(async () => {
    if (!dropboxKey) return 'no-key' as const
    try {
      await loadDropbox(dropboxKey)
      const chosen = await chooseFromDropbox()
      if (!chosen.length) return 'ok' as const
      toast(`Downloading ${chosen.length} photo(s) from Dropbox…`)
      const files: File[] = []
      for (const c of chosen) {
        try { files.push(await downloadChoice(c)) } catch (e: any) { toast(`${c.name}: ${e.message}`, 'error') }
      }
      await addFiles(files, 'dropbox')
    } catch (e: any) {
      toast(e.message || 'Dropbox import failed', 'error')
    }
    return 'ok' as const
  }, [addFiles, dropboxKey, toast])

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
    await DB.kvSet('customEmb', Object.fromEntries(customEmb.current))
  }, [ensureModel])

  const retagAll = useCallback(async () => {
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
      toast(`Tagging failed: ${e.message}`, 'error')
    }
  }, [ensureModel, tagWithEmbedding, toast])

  const preloadModel = useCallback(async () => {
    try { await ensureModel(); toast('Tagging model ready', 'ok') } catch (e: any) { toast(`Model download failed: ${e.message}`, 'error') }
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
          if (!p.tags.some((x) => x.name === t.name)) p = addTag(p, t.name, t.source, t.score)
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
    addFiles, importFromDropbox, updatePhotos, addTags, removeTags, deletePhotos, retagAll, retagPhoto, retryPending,
    saveSettings, addCustomLabel, removeCustomLabel, toggleLabel, resetVocabulary, exportData, importTags,
    clearEverything, toast, preloadModel,
  }), [ready, photos, settings, custom, job, model, toasts, dropboxKey, addFiles, importFromDropbox, updatePhotos, addTags, removeTags,
    deletePhotos, retagAll, retagPhoto, retryPending, saveSettings, addCustomLabel, removeCustomLabel, toggleLabel, resetVocabulary, exportData,
    importTags, clearEverything, toast, preloadModel])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export type { Tag }
