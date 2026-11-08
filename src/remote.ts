/**
 * Dropbox-backed photos live in Dropbox only. This module keeps them in memory for the session
 * and persists tags / faces / embeddings as JSON sidecars under /.photo-tagger/meta/ in the user's Dropbox.
 * Nothing about these photos is written to IndexedDB or the desktop library folder.
 */
import { activeDropbox, META_ROOT, toDropboxTagText, type DropboxClient } from './dropbox'
import type { Face, Person, Photo } from './types'
import { addTag, removeTag } from './tags'

const photos = new Map<string, Photo>()
const thumbs = new Map<string, Blob>()
const views = new Map<string, Blob>()
const embeddings = new Map<string, Float32Array>()
const faces = new Map<string, Face>()
let people: Person[] = []
const listeners = new Set<() => void>()
export const onRemoteChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const emit = () => listeners.forEach((f) => f())
const photoListeners = new Set<(ids: string[]) => void>()
/** photos changed inside remote.ts (e.g. a tag deleted in Dropbox) — the store reloads them */
export const onRemotePhotos = (fn: (ids: string[]) => void) => { photoListeners.add(fn); return () => { photoListeners.delete(fn) } }
const emitPhotos = (ids: string[]) => { if (ids.length) photoListeners.forEach((f) => f(ids)) }
/** tags Photo Tagger had on the file that are gone now were deleted in Dropbox: drop the chips (people stay — faces own them) and never write them back */
function applyRemoteRemovals(p: Photo, gone: string[]): Photo {
  if (!gone.length) return p
  let next = p
  for (const t of gone) for (const x of next.tags) if (x.source !== 'person' && toDropboxTag(x.name) === t) next = removeTag(next, x.name)
  const sup = [...new Set([...(p.dropboxRemoved ?? []), ...gone])].sort()
  return { ...next, dropboxRemoved: sup }
}

export const metaPath = (p: { dropbox?: { id: string } }) => `${META_ROOT}/meta/${p.dropbox!.id.replace(/^id:/, '').replace(/[^A-Za-z0-9_-]/g, '_')}.json`
const PEOPLE_PATH = `${META_ROOT}/people.json`

export const isRemotePhoto = (p: Photo | undefined) => !!p?.dropbox && !p.hasOriginal && p.source === 'dropbox'
export const hasRemote = (id: string) => photos.has(id)
export const remotePhotos = () => [...photos.values()]
export const remoteFaces = () => [...faces.values()]
export const remotePeople = () => people
export const remoteEmbeddings = () => new Map(embeddings)

// ---------- encoding ----------
function b64(bytes: Uint8Array) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s) }
function unb64(s: string) { const b = atob(s); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a }
const f32ToB64 = (f: Float32Array) => b64(new Uint8Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)))
const b64ToF32 = (s: string) => new Float32Array(unb64(s).buffer)

async function sidecar(id: string) {
  const p = photos.get(id)!
  const fs = [...faces.values()].filter((f) => f.photoId === id)
  const e = embeddings.get(id)
  return JSON.stringify({
    app: 'photo-tagger', version: 1, file: p.dropbox,
    photo: { ...p, dropboxTags: owned.get(id) ?? [] },
    embedding: e ? f32ToB64(e) : undefined,
    faces: await Promise.all(fs.map(async (f) => ({ ...f, descriptor: f32ToB64(f.descriptor), thumb: f.thumb && f.thumb.size ? b64(new Uint8Array(await f.thumb.arrayBuffer())) : undefined }))),
  })
}

// ---------- write-behind to Dropbox ----------
const dirty = new Set<string>()
let peopleDirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let flushing: Promise<void> = Promise.resolve()
export let onWriteError: ((e: unknown) => void) | null = null
export const setWriteErrorHandler = (fn: ((e: unknown) => void) | null) => { onWriteError = fn }
function schedule() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void flush() }, 500)
}
/** Write every pending change to Dropbox (resolves when done). */
export function flush(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  flushing = flushing.then(async () => {
    const c = activeDropbox()
    if (!c) return
    const ids = [...dirty]; dirty.clear()
    const doPeople = peopleDirty; peopleDirty = false
    let i = 0
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++]
        if (!photos.has(id)) continue
        await syncNativeTags(c, id)
        try { await c.writeMeta(metaPath(photos.get(id)!), await sidecar(id)) } catch (e) { dirty.add(id); onWriteError?.(e) }
      }
    }
    await Promise.all([worker(), worker(), worker()])
    if (doPeople) { try { await c.writeMeta(PEOPLE_PATH, JSON.stringify({ app: 'photo-tagger', version: 1, people })) } catch (e) { peopleDirty = true; onWriteError?.(e) } }
  })
  return flushing
}
;(globalThis as any).__ptFlushDropbox = flush

// ---------- native Dropbox file tags (searchable in Dropbox) ----------
/** Dropbox tag rules: lowercase, [a-z0-9_] only, 1..32 chars, at most 20 tags per file. */
export const DBX_TAG_MAX_LEN = 32
export const DBX_TAGS_PER_FILE = 20
export const toDropboxTag = toDropboxTagText
/** Tags we want on the file, most important first: people, then your own tags, then auto tags by confidence, then EXIF/quality. */
export function desiredDropboxTags(p: Photo): string[] {
  const rank = (s: string) => (s === 'person' ? 0 : s === 'manual' || s === 'dropbox' ? 1 : s === 'auto' ? 2 : 3)
  const sorted = [...p.tags].sort((a, b) => rank(a.source) - rank(b.source) || (b.score ?? 0) - (a.score ?? 0))
  const out: string[] = []
  const sup = new Set(p.dropboxRemoved ?? [])
  for (const t of sorted) { const d = toDropboxTag(t.name); if (d && !sup.has(d) && !out.includes(d)) out.push(d) }
  return out
}
const syncedKey = new Map<string, string>()

/**
 * Pull the file's existing native Dropbox tags into Photo Tagger as editable manual tags.
 * Tags already matching a photo tag (after toDropboxTag) aren't duplicated. Every native tag that now
 * corresponds to a photo tag counts as Photo Tagger-managed, so removing the chip removes it in Dropbox too.
 * Returns the ids of photos whose tag list changed.
 */
/** The '/…' path the Dropbox Tags API requires (it rejects 'id:…' with a 400). Resolves and remembers it if missing. */
async function tagPath(c: DropboxClient, p: Photo): Promise<string> {
  const cur = p.dropbox?.path
  if (cur && cur.startsWith('/')) return cur
  const path = await c.pathFor(p.dropbox!.id)
  const latest = photos.get(p.id)
  if (latest?.dropbox) { photos.set(p.id, { ...latest, dropbox: { ...latest.dropbox, path } }); touch(p.id) }
  return path
}

export async function importNativeTags(ids?: string[]): Promise<string[]> {
  const c = activeDropbox(); if (!c) return []
  const list = (ids ?? [...photos.keys()]).map((id) => photos.get(id)).filter((p): p is Photo => !!p?.dropbox)
  if (!list.length) return []
  let tags: Map<string, string[]>
  const paths = new Map<string, string>()
  try {
    for (const p of list) paths.set(p.id, await tagPath(c, p))
    tags = await c.getTagsMany([...paths.values()])
  } catch (e: any) { onWriteError?.(new Error(`Could not read Dropbox tags: ${e?.message || e}`)); return [] }
  const changed: string[] = []
  for (const p0 of list) {
    const p = photos.get(p0.id); if (!p) continue
    const native = (tags.get(paths.get(p.id)!) ?? []).filter((t) => toDropboxTag(t) === t && t.length > 0)
    const prev = owned.get(p.id) ?? []
    let next = applyRemoteRemovals(p, prev.filter((t) => !native.includes(t)))
    // a suppressed tag that is back on the file was re-added in Dropbox
    if (next.dropboxRemoved?.some((t) => native.includes(t))) next = { ...next, dropboxRemoved: next.dropboxRemoved.filter((t) => !native.includes(t)) }
    const have = new Set(next.tags.map((t) => toDropboxTag(t.name)))
    for (const t of native) if (!have.has(t)) { next = addTag(next, t, 'dropbox'); have.add(t) }
    const own = new Set([...prev.filter((t) => native.includes(t)), ...native.filter((t) => have.has(t))])
    owned.set(p.id, [...own].sort())
    if (next !== p) { photos.set(p.id, next); changed.push(p.id); touch(p.id) }
  }
  return changed
}
/** native tags Photo Tagger added, per photo id (persisted in the sidecar, independent of the app's photo objects) */
const owned = new Map<string, string[]>()
let tagErrorShown = false
async function syncNativeTags(c: DropboxClient, id: string) {
  let p = photos.get(id)
  if (!p?.dropbox) return
  let want = desiredDropboxTags(p)
  const key = want.join('|') + '#' + (owned.get(id) ?? []).join('|')
  if (syncedKey.get(id) === key) return
  try {
    const path = await tagPath(c, p)
    const current = new Set(await c.getTags(path))
    // older sidecars have no ownership record: tags we want that are already on the file count as ours,
    // so deleting one in Dropbox later is recognized (first-time missing tags are simply written)
    if (!(owned.get(id) ?? []).length) owned.set(id, want.filter((t) => current.has(t)).sort())
    // tags we had written that are gone from the file were deleted in Dropbox — honor that instead of writing them back
    const gone = (owned.get(id) ?? []).filter((t) => !current.has(t))
    if (gone.length) {
      p = applyRemoteRemovals(photos.get(id) ?? p, gone)
      photos.set(id, p); dirty.add(id); emitPhotos([id])
      want = desiredDropboxTags(p)
    }
    const ours = new Set((owned.get(id) ?? []).filter((t) => current.has(t)))
    // Dropbox allows 20 tags per file; tags from you/other apps keep their slots, the rest go to our highest-priority tags.
    // (Before 1.0.13 the low-priority tags already on a full file blocked every newly added tag.)
    const fit = want.slice(0, Math.max(0, DBX_TAGS_PER_FILE - [...current].filter((t) => !ours.has(t)).length))
    // remove only tags Photo Tagger itself added that are stale or crowded out
    for (const t of [...ours]) if (!fit.includes(t)) { await c.removeTag(path, t); ours.delete(t); current.delete(t) }
    let room = DBX_TAGS_PER_FILE - current.size
    for (const t of fit) {
      if (current.has(t)) continue // already there (ours, or added by you / another app — left alone)
      if (room <= 0) break
      try { await c.addTag(path, t); ours.add(t); current.add(t); room-- } catch (e: any) { if (/too_many_tags/.test(e?.message)) break; if (e?.status !== 409) throw e }
    }
    const list = [...ours].sort()
    owned.set(id, list)
    syncedKey.set(id, want.join('|') + '#' + list.join('|'))
  } catch (e: any) {
    if (!tagErrorShown) {
      tagErrorShown = true
      onWriteError?.(new Error(/missing_scope|403|app folder|not support/i.test(String(e?.message)) ? 'Dropbox search tags need the files.metadata.write permission and Full Dropbox access — enable it, then Disconnect and Connect again (Settings → Dropbox)' : String(e?.message || e)))
    }
  }
}
const touch = (id: string) => { dirty.add(id); schedule() }

// ---------- store operations (called by storage.ts) ----------
export function putPhoto(p: Photo) { photos.set(p.id, p); touch(p.id) }
export function savePhotoWithBlobs(p: Photo, b: { thumb: Blob; view: Blob }) {
  photos.set(p.id, p); thumbs.set(p.id, b.thumb); views.set(p.id, b.view); touch(p.id)
}
export function putEmbedding(id: string, e: Float32Array) { embeddings.set(id, e); touch(id) }
export function putFaces(fs: Face[]) { for (const f of fs) { faces.set(f.id, f); touch(f.photoId) } }
export function deleteFaceIds(ids: string[]) { for (const id of ids) { const f = faces.get(id); if (f) { faces.delete(id); touch(f.photoId) } } }
export function clearFaces() { const ids = new Set([...faces.values()].map((f) => f.photoId)); faces.clear(); ids.forEach(touch) }
export function setPeople(list: Person[]) { people = list; peopleDirty = true; schedule() }

/** Remove from the app; deletes only Photo Tagger's sidecar in Dropbox, never the photo. */
export async function deletePhotos(ids: string[]) {
  const c = activeDropbox()
  const gone: Photo[] = []
  for (const id of ids) {
    const p = photos.get(id); if (!p) continue
    gone.push(p); photos.delete(id); thumbs.delete(id); views.delete(id); embeddings.delete(id); dirty.delete(id)
    for (const f of [...faces.values()]) if (f.photoId === id) faces.delete(f.id)
  }
  if (c) await Promise.all(gone.map(async (p) => {
    // take back only the native tags Photo Tagger added; the photo itself is untouched
    const tp = await tagPath(c, p).catch(() => null)
    if (tp) for (const t of owned.get(p.id) ?? []) await c.removeTag(tp, t).catch(() => {})
    owned.delete(p.id); syncedKey.delete(p.id)
    await c.deleteMeta(metaPath(p)).catch(() => {})
  }))
}

export async function getBlob(store: 'thumbs' | 'views' | 'originals', id: string): Promise<Blob | undefined> {
  const p = photos.get(id); if (!p) return undefined
  if (store === 'originals') return undefined
  const cache = store === 'thumbs' ? thumbs : views
  const hit = cache.get(id); if (hit) return hit
  const c = activeDropbox(); if (!c) return undefined
  const b = await c.thumbnail(p.dropbox!.id, store === 'thumbs' ? 'w480h320' : 'w2048h1536')
  if (b) { cache.set(id, b.type ? b : new Blob([b], { type: 'image/jpeg' })); return cache.get(id) }
  return undefined
}

/** Forget everything held in memory (on disconnect / app wipe). Dropbox is untouched. */
export function clearMemory() {
  photos.clear(); thumbs.clear(); views.clear(); embeddings.clear(); faces.clear(); people = []; dirty.clear(); peopleDirty = false; syncedKey.clear(); owned.clear(); tagErrorShown = false
}

/** Read every sidecar from Dropbox into memory. */
export async function loadFromDropbox(c: DropboxClient = activeDropbox()!) {
  if (!c) return
  const list = (await c.listIfExists(`${META_ROOT}/meta`)).filter((e) => e.kind === 'file' && e.name.endsWith('.json'))
  const nextPhotos = new Map<string, Photo>(), nextFaces = new Map<string, Face>(), nextEmb = new Map<string, Float32Array>()
  let i = 0
  const worker = async () => {
    while (i < list.length) {
      const e = list[i++]
      try {
        const blob = await c.downloadRaw(e.id); if (!blob) continue
        const j = JSON.parse(await blob.text())
        if (j?.app !== 'photo-tagger' || !j.photo?.id) continue
        const p: Photo = { ...j.photo, hasOriginal: false, source: 'dropbox', relPath: undefined }
        nextPhotos.set(p.id, p)
        if (Array.isArray(j.photo.dropboxTags)) owned.set(p.id, j.photo.dropboxTags)
        if (j.embedding) nextEmb.set(p.id, b64ToF32(j.embedding))
        for (const f of j.faces ?? []) nextFaces.set(f.id, { ...f, descriptor: b64ToF32(f.descriptor), thumb: f.thumb ? new Blob([unb64(f.thumb)], { type: 'image/jpeg' }) : new Blob() })
      } catch { /* skip unreadable sidecar */ }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  const pj = await c.downloadRaw(PEOPLE_PATH).then((b) => b?.text()).catch(() => null)
  photos.clear(); nextPhotos.forEach((v, k) => photos.set(k, v))
  faces.clear(); nextFaces.forEach((v, k) => faces.set(k, v))
  embeddings.clear(); nextEmb.forEach((v, k) => embeddings.set(k, v))
  try { people = pj ? (JSON.parse(pj).people ?? []) : [] } catch { people = [] }
}
/** Tell listeners (People) that remote data changed — call after the photo list is refreshed. */
export const notifyRemote = emit
