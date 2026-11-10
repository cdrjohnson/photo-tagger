/**
 * Dropbox-backed photos live in Dropbox only. This module keeps them in memory for the session
 * and persists tags / faces / embeddings as JSON sidecars under /.photo-tagger/meta/ in the user's Dropbox.
 * Nothing about these photos is written to IndexedDB or the desktop library folder.
 */
import { activeDropbox, isTransientDropboxError, META_ROOT, toDropboxTagText, type DropboxClient } from './dropbox'
import type { Face, Person, Photo } from './types'
import { addTag, removeTag } from './tags'
import { compareDropboxTags, tagVerificationError, type TagVerification } from './tagVerification'

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

// ---------- write-behind to Dropbox (durable, retrying queue) ----------
const dirty = new Set<string>()
let peopleDirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let flushing: Promise<void> = Promise.resolve()
export let onWriteError: ((e: unknown) => void) | null = null
export const setWriteErrorHandler = (fn: ((e: unknown) => void) | null) => { onWriteError = fn }

const E2E = typeof window !== 'undefined' && !!(window as any).__PT_E2E__
/** How long one photo keeps retrying transient errors before it is listed as failed (Retry now restarts it). */
const retryWindowMs = () => Number((globalThis as any).__PT_RETRY_WINDOW_MS) || 30 * 60_000
/** Queue-level backoff between passes for a photo that hit a transient error (the client already retried a few times). */
const queueBackoff = (n: number) => { const top = Math.min(E2E ? 400 : 5 * 60_000, (E2E ? 40 : 2000) * 2 ** Math.min(n, 12)); return Math.round(top / 2 + Math.random() * top / 2) }
/** Two photos at a time: fewer 429s on bulk edits (each photo is several Tags API calls). */
const CONCURRENCY = 2

export type SaveFailureKind = 'cap' | 'permission' | 'not_found' | 'auth' | 'gave_up' | 'missing' | 'other'
export interface SaveFailure { id: string; name: string; kind: SaveFailureKind; reason: string; at: number }
export interface SaveStatus {
  /** photos in the current save run */ total: number
  done: number
  /** still waiting to be written (includes retrying) */ remaining: number
  retrying: number
  /** last transient problem while retrying, e.g. "Dropbox is rate limiting" */ retryReason?: string
  failures: SaveFailure[]
}
const retry = new Map<string, { n: number; first: number; next: number; reason: string }>()
const failures = new Map<string, SaveFailure>()
const inflight = new Set<string>()
const batch = new Set<string>()
const statusListeners = new Set<(s: SaveStatus) => void>()
export const onSaveStatus = (fn: (s: SaveStatus) => void) => { statusListeners.add(fn); fn(saveStatus()); return () => { statusListeners.delete(fn) } }
export function saveStatus(): SaveStatus {
  const pending = new Set([...dirty, ...inflight])
  const total = pending.size ? batch.size : 0
  const rs = [...retry.values()].sort((a, b) => b.n - a.n)
  return { total, done: total - pending.size, remaining: pending.size, retrying: retry.size, retryReason: rs[0]?.reason, failures: [...failures.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}
/** Photos with edits not yet confirmed in Dropbox (used to warn before closing). */
export const pendingWrites = () => new Set([...dirty, ...inflight]).size + (peopleDirty ? 1 : 0)
let statusRaf = 0
function emitStatus() {
  if (!dirty.size && !inflight.size) batch.clear()
  if (statusRaf) return
  statusRaf = 1
  queueMicrotask(() => { statusRaf = 0; const st = saveStatus(); statusListeners.forEach((f) => f(st)) })
}

// The queue survives closing the app: only ids + the tag state to write are kept (a few hundred bytes per photo).
const QUEUE_KEY = 'pt.dropboxQueue.v1'
type QueuedState = { id: string; tags: Photo['tags']; rejected: string[]; dropboxRemoved?: string[] }
let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistQueue() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      const ids = new Set([...dirty, ...inflight, ...[...failures.values()].filter((f) => f.kind !== 'cap').map((f) => f.id)])
      const items: QueuedState[] = [...ids].map((id) => photos.get(id)).filter((p): p is Photo => !!p)
        .map((p) => ({ id: p.id, tags: p.tags, rejected: p.rejected, dropboxRemoved: p.dropboxRemoved }))
      if (items.length || peopleDirty) localStorage.setItem(QUEUE_KEY, JSON.stringify({ v: 1, people: peopleDirty, items }))
      else localStorage.removeItem(QUEUE_KEY)
    } catch { /* storage full / unavailable: the in-memory queue still runs */ }
  }, 200)
}
export function persistedQueue(): { people: boolean; items: QueuedState[] } {
  try { const j = JSON.parse(localStorage.getItem(QUEUE_KEY) || 'null'); return j?.v === 1 ? { people: !!j.people, items: j.items ?? [] } : { people: false, items: [] } } catch { return { people: false, items: [] } }
}
export function clearPersistedQueue() { try { localStorage.removeItem(QUEUE_KEY) } catch { /* ignore */ } }

function schedule(ms = 500) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void flush(false) }, ms)
}
function classify(e: any): { transient: boolean; kind: SaveFailureKind; reason: string } {
  const msg = String(e?.message ?? e ?? ''), st = Number(e?.status ?? 0)
  if (/missing_scope|app folder|not support/i.test(msg) || st === 403)
    return { transient: false, kind: 'permission', reason: 'Permission denied — enable files.metadata.write and Full Dropbox access for your Dropbox app, then Disconnect and Connect again (Settings → Dropbox)' }
  if (/not_found/i.test(msg)) return { transient: false, kind: 'not_found', reason: 'File not found in Dropbox (moved, renamed or deleted?)' }
  if (st === 401 || /sign-in failed|invalid_access_token|expired_access_token/i.test(msg)) return { transient: false, kind: 'auth', reason: 'Dropbox sign-in expired — connect again in Settings → Dropbox' }
  if (isTransientDropboxError(e) || !st) {
    const reason = st === 429 || /too_many/.test(msg) ? 'Dropbox is rate limiting — slowing down' : st >= 500 ? `Dropbox server error (${st})` : /timed out/i.test(msg) ? 'Dropbox request timed out' : 'Network problem'
    return { transient: true, kind: 'gave_up', reason }
  }
  return { transient: false, kind: 'other', reason: msg.slice(0, 200) || 'Unknown error' }
}
function finish(id: string, capped: string[]) {
  retry.delete(id)
  const p = photos.get(id)
  if (capped.length && p) failures.set(id, { id, name: p.name, kind: 'cap', at: Date.now(), reason: `Dropbox allows 20 tags per file and this file is full — not written: ${capped.join(', ')}` })
  else failures.delete(id)
}
function fail(id: string, e: any) {
  const p = photos.get(id); if (!p) { retry.delete(id); return }
  const c = classify(e), now = Date.now()
  if (!c.transient) { retry.delete(id); failures.set(id, { id, name: p.name, kind: c.kind, reason: c.reason, at: now }); return }
  const r = retry.get(id) ?? { n: 0, first: now, next: now, reason: c.reason }
  r.n++; r.reason = c.reason
  if (now - r.first > retryWindowMs()) {
    retry.delete(id)
    failures.set(id, { id, name: p.name, kind: 'gave_up', at: now, reason: `Still failing after retrying for ${Math.round(retryWindowMs() / 60_000) || '<1'} min: ${c.reason}` })
    return
  }
  r.next = now + queueBackoff(r.n); retry.set(id, r); dirty.add(id)
}

/**
 * Write pending changes to Dropbox. `force` (default — Verify, Disconnect, tests) also retries photos that are
 * waiting out a backoff right now. Resolves when this pass is done; photos that hit a transient error stay queued.
 */
export function flush(force = true): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  flushing = flushing.then(async () => {
    const c = activeDropbox()
    if (!c) return
    const now = Date.now()
    const ids = [...dirty].filter((id) => force || (retry.get(id)?.next ?? 0) <= now)
    for (const id of ids) { dirty.delete(id); inflight.add(id) }
    emitStatus()
    const doPeople = peopleDirty; peopleDirty = false
    let i = 0
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++]
        try {
          if (!photos.has(id)) { retry.delete(id); continue }
          const capped = await syncNativeTags(c, id)
          await c.writeMeta(metaPath(photos.get(id)!), await sidecar(id))
          finish(id, capped)
        } catch (e) { fail(id, e) } finally { inflight.delete(id); emitStatus(); persistQueue() }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    if (doPeople) {
      try { await c.writeMeta(PEOPLE_PATH, JSON.stringify({ app: 'photo-tagger', version: 1, people })) }
      catch (e) { peopleDirty = true; if (!classify(e).transient) onWriteError?.(e) }
    }
    persistQueue(); emitStatus()
    if (dirty.size || peopleDirty) {
      const next = Math.min(...[...dirty].map((id) => retry.get(id)?.next ?? Date.now()), peopleDirty ? Date.now() + queueBackoff(1) : Infinity)
      schedule(Math.max(50, next - Date.now()))
    }
  })
  return flushing
}
/** Resolves once none of these photos is waiting to be written (each either landed or is on the failure list). */
export function waitForSaved(ids: string[], signal?: AbortSignal): Promise<void> {
  const set = new Set(ids)
  const done = () => ![...set].some((id) => dirty.has(id) || inflight.has(id))
  if (done()) return Promise.resolve()
  return new Promise((res, rej) => {
    let off: (() => void) | null = null
    const stop = () => { off?.(); signal?.removeEventListener('abort', abort) }
    const abort = () => { stop(); rej(new DOMException('Aborted', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    off = onSaveStatus(() => { if (done()) { stop(); res() } })
  })
}
/** After a batch is verified: list photos whose tags did not all land (with the reason) so Retry now can fix them. */
export function reportVerifyProblems(rows: TagVerification[]): number {
  let n = 0
  for (const r of rows) {
    if (r.skipped || r.pending || !photos.has(r.id)) continue
    let f: SaveFailure | null = null
    if (r.error) f = { id: r.id, name: r.name, kind: 'other', at: Date.now(), reason: `Checking tags in Dropbox failed: ${r.error}` }
    else if (r.atCap.length) f = { id: r.id, name: r.name, kind: 'cap', at: Date.now(), reason: `Dropbox allows 20 tags per file and this file is full — not written: ${r.atCap.join(', ')}` }
    else if (r.missing.length) f = { id: r.id, name: r.name, kind: 'missing', at: Date.now(), reason: `Verified after import: missing in Dropbox: ${r.missing.join(', ')}` }
    if (f) { failures.set(r.id, f); n++ }
  }
  if (n) { emitStatus(); persistQueue() }
  return n
}
/** Retry every photo on the failure list now (fresh retry window). */
export function retryFailed(ids?: string[]) {
  for (const f of [...failures.values()]) if (!ids || ids.includes(f.id)) { failures.delete(f.id); syncedKey.delete(f.id); retry.delete(f.id); if (photos.has(f.id)) { dirty.add(f.id); batch.add(f.id) } }
  emitStatus(); persistQueue(); schedule(0)
}
export function dismissFailures() { failures.clear(); emitStatus(); persistQueue() }
/** After loading sidecars: put back edits that had not reached Dropbox when the app was closed, and queue them. */
function resumePersisted() {
  const q = persistedQueue()
  for (const it of q.items) {
    const p = photos.get(it.id); if (!p) continue
    photos.set(it.id, { ...p, tags: it.tags, rejected: it.rejected, dropboxRemoved: it.dropboxRemoved })
    dirty.add(it.id); batch.add(it.id)
  }
  if (q.people) peopleDirty = true
  if (q.items.length || q.people) { emitStatus(); schedule(300) }
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
/** Flush edits, then read back native tags only. Does not import, re-tag, or fetch media bytes. */
export async function verifyDropboxTags(list: readonly Photo[], onProgress?: (done: number, total: number) => void): Promise<TagVerification[]> {
  await flush()
  const c = activeDropbox()
  const out: TagVerification[] = []
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20)
    const paths = new Map<string, string>()
    const results = new Map<string, TagVerification>()
    for (const p of chunk) {
      const row: TagVerification = { id: p.id, name: p.name, landed: [], missing: [], atCap: [] }
      if (!p.dropbox) results.set(p.id, { ...row, skipped: 'Not Dropbox-backed — skipped' })
      else if (!c) results.set(p.id, { ...row, error: 'Connect Dropbox in Settings → Dropbox to verify tags.' })
      else {
        try { paths.set(p.id, await tagPath(c, p)) }
        catch (e) { results.set(p.id, { ...row, error: tagVerificationError(e) }) }
      }
    }
    if (c && paths.size) {
      try {
        // getTagsMany uses Dropbox's 20-path batch size; no photo/video downloads.
        const actual = await c.getTagsMany([...paths.values()])
        for (const p0 of chunk) {
          const path = paths.get(p0.id); if (!path) continue
          const p = photos.get(p0.id) ?? p0 // flush may have applied remote deletions/suppressions
          const native = actual.get(path)
          if (!native) results.set(p.id, { id: p.id, name: p.name, landed: [], missing: [], atCap: [], error: 'Dropbox returned no tag result for this file. Try again.' })
          else results.set(p.id, { id: p.id, name: p.name, nativeCount: c.tagCount(path), ...compareDropboxTags(desiredDropboxTags(p), native, c.tagCount(path), DBX_TAGS_PER_FILE), ...(dirty.has(p.id) ? { pending: `Still saving to Dropbox — retrying (${retry.get(p.id)?.reason ?? 'queued'})` } : failures.has(p.id) && failures.get(p.id)!.kind !== 'cap' ? { pending: `Could not save: ${failures.get(p.id)!.reason}` } : {}) })
        }
      } catch (e) {
        for (const p of chunk) if (paths.has(p.id)) results.set(p.id, { id: p.id, name: p.name, landed: [], missing: [], atCap: [], error: tagVerificationError(e) })
      }
    }
    out.push(...chunk.map((p) => results.get(p.id)!))
    onProgress?.(out.length, list.length)
  }
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
  // local edits not yet in Dropbox win: write them first, and don't re-import a photo that is still queued
  const want = ids ?? [...photos.keys()]
  if (want.some((id) => dirty.has(id) || inflight.has(id))) await flush(true)
  const list = want.filter((id) => !dirty.has(id) && !inflight.has(id)).map((id) => photos.get(id)).filter((p): p is Photo => !!p?.dropbox)
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
/** Make the file's native tags match; returns desired tags that could not be written because the file has 20 tags. Throws on API errors (the queue retries). */
async function syncNativeTags(c: DropboxClient, id: string): Promise<string[]> {
  let p = photos.get(id)
  if (!p?.dropbox) return []
  let want = desiredDropboxTags(p)
  const key = want.join('|') + '#' + (owned.get(id) ?? []).join('|')
  if (syncedKey.get(id) === key) return failures.get(id)?.kind === 'cap' ? want.filter((t) => !(owned.get(id) ?? []).includes(t)) : []
  const path = await tagPath(c, p)
  const current = new Set(await c.getTags(path))
  // older sidecars have no ownership record: tags we want that are already on the file count as ours,
  // so deleting one in Dropbox later is recognized (first-time missing tags are simply written)
  if (!(owned.get(id) ?? []).length) owned.set(id, want.filter((t) => current.has(t)).sort())
  // tags we had written that are gone from the file were deleted in Dropbox — honor that instead of writing them back
  const gone = (owned.get(id) ?? []).filter((t) => !current.has(t))
  if (gone.length) {
    p = applyRemoteRemovals(photos.get(id) ?? p, gone)
    photos.set(id, p); emitPhotos([id])
    want = desiredDropboxTags(p)
  }
  const ours = new Set((owned.get(id) ?? []).filter((t) => current.has(t)))
  // Dropbox allows 20 tags per file; tags from you/other apps keep their slots, the rest go to our highest-priority tags.
  const fit = want.slice(0, Math.max(0, DBX_TAGS_PER_FILE - [...current].filter((t) => !ours.has(t)).length))
  // remove only tags Photo Tagger itself added that are stale or crowded out
  for (const t of [...ours]) if (!fit.includes(t)) { await c.removeTag(path, t); ours.delete(t); current.delete(t); owned.set(id, [...ours].sort()) }
  let room = DBX_TAGS_PER_FILE - current.size
  for (const t of fit) {
    if (current.has(t)) continue // already there (ours, or added by you / another app — left alone)
    if (room <= 0) break
    try { await c.addTag(path, t); ours.add(t); current.add(t); room--; owned.set(id, [...ours].sort()) }
    catch (e: any) { if (/too_many_tags/.test(e?.message)) break; if (!(e?.status === 409 && !isTransientDropboxError(e) && !/not_found/.test(e?.message))) throw e }
  }
  const list = [...ours].sort()
  owned.set(id, list)
  syncedKey.set(id, want.join('|') + '#' + list.join('|'))
  return current.size >= DBX_TAGS_PER_FILE ? want.filter((t) => !current.has(t)) : []
}
const touch = (id: string) => { dirty.add(id); batch.add(id); if (!retry.has(id)) schedule(); emitStatus(); persistQueue() }

// ---------- store operations (called by storage.ts) ----------
export function putPhoto(p: Photo) { photos.set(p.id, p); touch(p.id) }
export function savePhotoWithBlobs(p: Photo, b: { thumb: Blob; view: Blob }) {
  photos.set(p.id, p); thumbs.set(p.id, b.thumb); views.set(p.id, b.view); touch(p.id)
}
export function putEmbedding(id: string, e: Float32Array) { embeddings.set(id, e); touch(id) }
export function putFaces(fs: Face[]) { for (const f of fs) { faces.set(f.id, f); touch(f.photoId) } }
export function deleteFaceIds(ids: string[]) { for (const id of ids) { const f = faces.get(id); if (f) { faces.delete(id); touch(f.photoId) } } }
export function clearFaces() { const ids = new Set([...faces.values()].map((f) => f.photoId)); faces.clear(); ids.forEach(touch) }
export function setPeople(list: Person[]) { people = list; peopleDirty = true; schedule(); persistQueue() }

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
  const asImg = (b: Blob) => (b.type ? b : new Blob([b], { type: 'image/jpeg' }))
  const fetchSize = async (size: string) => {
    // by id first, then by '/…' path (some Dropbox endpoints only take paths)
    let b = await thumbSlot(() => c.thumbnail(p.dropbox!.id, size))
    if (!b && p.dropbox!.path?.startsWith('/')) b = await thumbSlot(() => c.thumbnail(p.dropbox!.path, size))
    return b
  }
  if (store === 'thumbs') {
    const b = await fetchSize('w480h320')
    if (b) { thumbs.set(id, asImg(b)); return thumbs.get(id) }
    // the grid's small size failed: show the same preview the editor uses
    const v = views.get(id) ?? (await fetchSize('w2048h1536'))
    if (v) { views.set(id, asImg(v)); return views.get(id) }
    return undefined
  }
  const b = await fetchSize('w2048h1536')
  if (b) { views.set(id, asImg(b)); return views.get(id) }
  return undefined
}
/** at most 4 Dropbox thumbnail requests at a time, so a big grid doesn't stampede the API */
let thumbActive = 0
const thumbQueue: (() => void)[] = []
async function thumbSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (thumbActive >= 4) await new Promise<void>((r) => thumbQueue.push(r))
  thumbActive++
  try { return await fn() } finally { thumbActive--; thumbQueue.shift()?.() }
}

/** Forget everything held in memory (on disconnect / app wipe). Dropbox is untouched. */
export function clearMemory() {
  photos.clear(); thumbs.clear(); views.clear(); embeddings.clear(); faces.clear(); people = []; dirty.clear(); peopleDirty = false; syncedKey.clear(); owned.clear(); retry.clear(); failures.clear(); inflight.clear(); batch.clear(); emitStatus()
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
  resumePersisted()
}
/** Tell listeners (People) that remote data changed — call after the photo list is refreshed. */
export const notifyRemote = emit
