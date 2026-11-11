/**
 * Dropbox-backed photos live in Dropbox only. This module keeps them in memory for the session
 * and persists tags / faces / embeddings as JSON sidecars under /.photo-tagger/meta/ in the user's Dropbox.
 * Nothing about these photos is written to IndexedDB or the desktop library folder.
 */
import { activeDropbox, isNotFoundError, isTransientDropboxError, META_ROOT, toDropboxTagText, type DropboxClient } from './dropbox'
import type { Face, Person, Photo } from './types'
import { addTag, removeTag, repairPhotoTags } from './tags'
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
/** Reading tags from Dropbox failed for some photos (after the client's own retries). Never phrased as a save error. */
export let onReadError: ((e: unknown, count: number) => void) | null = null
export const setReadErrorHandler = (fn: ((e: unknown, count: number) => void) | null) => { onReadError = fn }

// ---------- files that are no longer in Dropbox (1.0.28) ----------
/** A photo whose Dropbox file was deleted (its id no longer resolves). Moved/renamed files are relinked instead. */
export interface MissingFile { id: string; name: string; path: string; at: number }
/** thrown inside the queue / verify when a photo's file is gone from Dropbox (not an error to retry) */
export class MissingFileError extends Error { constructor(name: string) { super(`${name} is no longer in Dropbox`) } }
const missing = new Map<string, MissingFile>()
const MISSING_DISMISS_KEY = 'pt.dropboxMissingDismissed.v1'
const dismissedMissing = (): string[] => { try { return JSON.parse(localStorage.getItem(MISSING_DISMISS_KEY) || '[]') } catch { return [] } }
/** photos whose tags were repaired on load (1.0.28); their Dropbox writes are queued after the startup tag read */
const repaired = new Set<string>()
/** photos whose Dropbox path changed this session (moved / renamed in Dropbox) */
const relinked = new Set<string>()
function markMissing(p: Photo) {
  missing.set(p.id, { id: p.id, name: p.name, path: p.dropbox?.path ?? '', at: Date.now() })
  // never retried or listed as a save failure: it is reported once, in the "no longer in Dropbox" notice
  dirty.delete(p.id); retry.delete(p.id); failures.delete(p.id); syncedKey.delete(p.id)
  emitStatus(); persistQueue()
}
export const isMissing = (id: string) => missing.has(id)
/** Hide the notice for these files (remembered on this device until they show up again or are removed). */
export function dismissMissing() {
  try { localStorage.setItem(MISSING_DISMISS_KEY, JSON.stringify([...new Set([...dismissedMissing(), ...missing.keys()])])) } catch { /* ignore */ }
  emitStatus()
}
/**
 * The stored path is gone: look the file up by its Dropbox id (ids survive moves and renames).
 * Found → the photo's path (and name) are updated, the sidecar is rewritten so it persists, and the new path is returned.
 * Deleted → listed as missing, returns null. Other errors (network…) throw.
 */
async function relink(c: DropboxClient, id: string): Promise<string | null> {
  const p = photos.get(id); if (!p?.dropbox) return null
  const loc = await c.locate(p.dropbox.id)
  if (!loc) { markMissing(p); return null }
  missing.delete(id)
  const latest = photos.get(id) ?? p
  if (latest.dropbox && (latest.dropbox.path !== loc.path || latest.name !== loc.name)) {
    photos.set(id, { ...latest, name: loc.name, dropbox: { ...latest.dropbox, path: loc.path } })
    relinked.add(id); syncedKey.delete(id); touch(id); emitPhotos([id])
  }
  return loc.path
}

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
  /** photos whose file was deleted from Dropbox (not dismissed) */
  missing: MissingFile[]
  /** Remove from app (1.0.29): photos in the current removal run, and how many are finished */
  removeTotal: number
  removeDone: number
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
  return { total, done: total - pending.size, remaining: pending.size, retrying: retry.size, retryReason: rs[0]?.reason, failures: [...failures.values()].sort((a, b) => a.name.localeCompare(b.name)), missing: missingList(), ...removeProgress() }
}
function missingList(): MissingFile[] {
  const hide = new Set(dismissedMissing())
  return [...missing.values()].filter((m) => photos.has(m.id) && !hide.has(m.id)).sort((a, b) => a.name.localeCompare(b.name))
}
/** Photos with edits not yet confirmed in Dropbox (used to warn before closing). */
export const pendingWrites = () => new Set([...dirty, ...inflight]).size + (peopleDirty ? 1 : 0) + removals.size
let statusRaf = 0
function emitStatus() {
  if (!dirty.size && !inflight.size) batch.clear()
  if (![...removals.keys()].some((id) => !failures.has(id))) rmBatch.clear()
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
export function clearPersistedQueue() { try { localStorage.removeItem(QUEUE_KEY); localStorage.removeItem(REMOVE_KEY) } catch { /* ignore */ } }

// ---------- Remove from app: durable, paced removal queue + tombstones (1.0.29) ----------
/**
 * One photo being removed from the app: take back the native tags Photo Tagger added, then delete its sidecar.
 * While pending it is a tombstone — nothing may write its sidecar again and loading skips it.
 */
interface Removal { id: string; file: string; name: string; meta: string; path?: string; tags: string[]; n?: number; first?: number; next?: number }
const removals = new Map<string, Removal>()
const rmBatch = new Set<string>()
const REMOVE_KEY = 'pt.dropboxRemovals.v1'
/** removed photo ids, also kept in Dropbox (/.photo-tagger/removed.json) so other devices / reinstalls don't bring them back */
type RemovedEntry = { id: string; file: string; at: number; done?: number }
let removedLog: RemovedEntry[] = []
const removedIds = new Set<string>()
let removedLogDirty = false
const REMOVED_PATH = `${META_ROOT}/removed.json`
const REMOVED_KEEP_MS = 90 * 24 * 3600_000
export const isRemoved = (id: string) => removedIds.has(id) || removals.has(id)
function removeProgress() {
  const total = rmBatch.size
  const left = [...rmBatch].filter((id) => removals.has(id) && !failures.has(id)).length
  return { removeTotal: left ? total : 0, removeDone: left ? total - left : 0 }
}
function persistRemovals() {
  try {
    const items = [...removals.values()].map(({ id, file, name, meta, path, tags }) => ({ id, file, name, meta, path, tags }))
    if (items.length) localStorage.setItem(REMOVE_KEY, JSON.stringify({ v: 1, items }))
    else localStorage.removeItem(REMOVE_KEY)
  } catch { /* storage unavailable: the in-memory queue still runs */ }
}
function restoreRemovals() {
  try {
    const j = JSON.parse(localStorage.getItem(REMOVE_KEY) || 'null')
    for (const r of (j?.v === 1 ? j.items : []) as Removal[]) if (r?.id && r.meta && !removals.has(r.id)) { removals.set(r.id, { ...r, tags: r.tags ?? [] }); rmBatch.add(r.id); removedIds.add(r.id) }
  } catch { /* ignore */ }
}
function addRemovedLog(id: string, file: string) {
  if (!removedLog.some((e) => e.id === id)) removedLog.push({ id, file, at: Date.now() })
  removedIds.add(id)
  removedLogDirty = true
}
/** Merge our removed list into Dropbox's (other devices may have added theirs), prune old finished entries, write it. */
async function writeRemovedLog(c: DropboxClient) {
  const cur = await c.downloadRaw(REMOVED_PATH).then((b) => b?.text()).catch(() => null)
  let theirs: RemovedEntry[] = []
  try { theirs = cur ? (JSON.parse(cur).removed ?? []) : [] } catch { theirs = [] }
  const by = new Map<string, RemovedEntry>()
  for (const e of [...theirs, ...removedLog]) { const o = by.get(e.id); by.set(e.id, o ? { ...o, ...e, done: Math.max(o.done ?? 0, e.done ?? 0) || undefined } : e) }
  const now = Date.now()
  removedLog = [...by.values()].filter((e) => !e.done || now - e.done < REMOVED_KEEP_MS || removals.has(e.id)).slice(-20_000)
  removedLog.forEach((e) => removedIds.add(e.id))
  await c.writeMeta(REMOVED_PATH, JSON.stringify({ app: 'photo-tagger', version: 1, removed: removedLog }))
}
/** Queue a removal (from a live photo, or a leftover sidecar of an already-removed id found while loading). */
function queueRemoval(r: Removal) {
  removals.set(r.id, r); rmBatch.add(r.id); addRemovedLog(r.id, r.file)
}
async function processRemoval(c: DropboxClient, r: Removal, liveFiles: Set<string>) {
  // re-added on purpose since then: the new photo owns this file and its sidecar now — nothing to undo
  if (liveFiles.has(r.file)) { removals.delete(r.id); owned.delete(r.id); return }
  const tags = [...new Set([...r.tags, ...(owned.get(r.id) ?? [])])]
  if (tags.length && r.path) {
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i]
      try { await c.removeTag(r.path, t) }
      catch (e) {
        if (!isNotFoundError(e)) throw e
        const loc = await c.locate(r.file) // moved/renamed: follow the id; deleted: no tags left to take back
        if (!loc) { r.path = undefined; break }
        r.path = loc.path
        await c.removeTag(r.path, t)
      }
      r.tags = tags.slice(i + 1); owned.set(r.id, (owned.get(r.id) ?? []).filter((x) => x !== t))
      persistRemovals()
    }
  }
  await c.deleteMeta(r.meta) // not_found = already gone
  removals.delete(r.id); owned.delete(r.id); retry.delete('rm:' + r.id); failures.delete(r.id)
  const e = removedLog.find((x) => x.id === r.id); if (e) e.done = Date.now()
  removedLogDirty = true
}
function failRemoval(r: Removal, e: any) {
  const k = classify(e), now = Date.now()
  r.n = (r.n ?? 0) + 1; r.first ??= now
  if (k.transient && now - r.first <= retryWindowMs()) { r.next = now + queueBackoff(r.n); retry.set('rm:' + r.id, { n: r.n, first: r.first, next: r.next, reason: k.reason }); return }
  retry.delete('rm:' + r.id); r.next = Infinity
  failures.set(r.id, { id: r.id, name: r.name, kind: k.transient ? 'gave_up' : k.kind, at: now, reason: `Could not finish removing it from Dropbox (Photo Tagger's tags/tag file are still there; the photo itself is never touched): ${k.reason}` })
}

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
          if (!photos.has(id) || missing.has(id)) { retry.delete(id); continue }
          const capped = await syncNativeTags(c, id)
          // removed meanwhile: never (re)create its sidecar
          if (isRemoved(id) || !photos.has(id)) { retry.delete(id); continue }
          const body = await sidecar(id)
          if (isRemoved(id) || !photos.has(id)) { retry.delete(id); continue }
          await c.writeMeta(metaPath(photos.get(id)!), body)
          finish(id, capped)
        } catch (e) { if (e instanceof MissingFileError) dirty.delete(id); else fail(id, e) } finally { inflight.delete(id); emitStatus(); persistQueue() }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    // Remove from app: paced like the writes (two at a time), never while that photo's own upload is still in flight
    const due = [...removals.values()].filter((r) => !inflight.has(r.id) && (r.next ?? 0) !== Infinity && (force || (r.next ?? 0) <= Date.now()))
    if (due.length) {
      // record the tombstones in Dropbox first, so a reinstall / other device never loads these photos again
      if (removedLogDirty) { removedLogDirty = false; try { await writeRemovedLog(c) } catch { removedLogDirty = true } }
      const liveFiles = new Set([...photos.values()].map((p) => p.dropbox?.id).filter(Boolean) as string[])
      let k = 0
      const rmWorker = async () => {
        while (k < due.length) {
          const r = due[k++]
          try { await processRemoval(c, r, liveFiles) } catch (e) { failRemoval(r, e) } finally { persistRemovals(); emitStatus() }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, rmWorker))
    }
    if (removedLogDirty) {
      removedLogDirty = false
      try { await writeRemovedLog(c) } catch { removedLogDirty = true }
    }
    if (doPeople) {
      try { await c.writeMeta(PEOPLE_PATH, JSON.stringify({ app: 'photo-tagger', version: 1, people })) }
      catch (e) { peopleDirty = true; if (!classify(e).transient) onWriteError?.(e) }
    }
    persistQueue(); emitStatus()
    const rmNext = [...removals.values()].map((r) => r.next ?? Date.now()).filter((t) => t !== Infinity)
    if (dirty.size || peopleDirty || rmNext.length || removedLogDirty) {
      const next = Math.min(...[...dirty].map((id) => retry.get(id)?.next ?? Date.now()), ...rmNext, peopleDirty || removedLogDirty ? Date.now() + queueBackoff(1) : Infinity)
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
    if (r.skipped || r.pending || !photos.has(r.id) || missing.has(r.id)) continue
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
  for (const f of [...failures.values()]) if (!ids || ids.includes(f.id)) {
    failures.delete(f.id); syncedKey.delete(f.id); retry.delete(f.id)
    const r = removals.get(f.id)
    if (r) { r.n = 0; r.first = undefined; r.next = 0; rmBatch.add(r.id) }
    else if (photos.has(f.id)) { dirty.add(f.id); batch.add(f.id) }
  }
  emitStatus(); persistQueue(); schedule(0)
}
export function dismissFailures() { failures.clear(); emitStatus(); persistQueue() }
/** After loading sidecars: put back edits that had not reached Dropbox when the app was closed, and queue them. */
function resumePersisted() {
  const q = persistedQueue()
  for (const it of q.items) {
    const p = photos.get(it.id); if (!p) continue
    photos.set(it.id, repairPhotoTags({ ...p, tags: it.tags, rejected: it.rejected, dropboxRemoved: it.dropboxRemoved }))
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
  const GONE = 'No longer in Dropbox — the file was deleted. It is listed under “no longer in Dropbox”, where you can remove it from the app.'
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20)
    const paths = new Map<string, string>()
    const results = new Map<string, TagVerification>()
    const row = (p: Photo): TagVerification => ({ id: p.id, name: photos.get(p.id)?.name ?? p.name, landed: [], missing: [], atCap: [] })
    for (const p of chunk) {
      if (!p.dropbox) results.set(p.id, { ...row(p), skipped: 'Not Dropbox-backed — skipped' })
      else if (!c) results.set(p.id, { ...row(p), error: 'Connect Dropbox in Settings → Dropbox to verify tags.' })
      else {
        try { paths.set(p.id, await tagPath(c, photos.get(p.id) ?? p)) }
        catch (e) { results.set(p.id, { ...row(p), error: e instanceof MissingFileError ? GONE : tagVerificationError(e) }) }
      }
    }
    if (c && paths.size) {
      // getTagsSafe: 20 paths per request; a moved/deleted file doesn't spoil the rest of its batch. No photo/video downloads.
      const got = await readTags(c, paths)
      for (const p0 of chunk) {
        if (results.has(p0.id)) continue
        const p = photos.get(p0.id) ?? p0 // flush may have applied remote deletions/suppressions; relink may have moved it
        if (missing.has(p.id)) { results.set(p.id, { ...row(p), error: GONE }); continue }
        const err = got.errors.get(p.id)
        if (err) { results.set(p.id, { ...row(p), error: tagVerificationError(err) }); continue }
        const path = paths.get(p.id)!
        const native = got.tags.get(p.id)
        if (!native) results.set(p.id, { ...row(p), error: 'Dropbox returned no tag result for this file. Try again.' })
        else results.set(p.id, { id: p.id, name: p.name, nativeCount: c.tagCount(path), ...compareDropboxTags(desiredDropboxTags(p), native, c.tagCount(path), DBX_TAGS_PER_FILE), ...(dirty.has(p.id) ? { pending: `Still saving to Dropbox — retrying (${retry.get(p.id)?.reason ?? 'queued'})` } : failures.has(p.id) && failures.get(p.id)!.kind !== 'cap' ? { pending: `Could not save: ${failures.get(p.id)!.reason}` } : {}) })
      }
    }
    out.push(...chunk.map((p) => results.get(p.id)!))
    onProgress?.(out.length, list.length)
  }
  return out
}

/**
 * Read native tags for photos (id → path). Paths that are gone are looked up by file id: moved/renamed files are
 * relinked (paths map updated) and read again; deleted ones are marked missing. Per-batch errors stay per photo.
 */
async function readTags(c: DropboxClient, paths: Map<string, string>): Promise<{ tags: Map<string, string[]>; errors: Map<string, unknown> }> {
  const tags = new Map<string, string[]>(), errors = new Map<string, unknown>()
  const take = (r: Awaited<ReturnType<DropboxClient['getTagsSafe']>>, ids: string[]) => {
    const again: string[] = []
    for (const id of ids) {
      const path = paths.get(id)!
      const t = r.tags.get(path)
      if (t) tags.set(id, t)
      else if (r.failed.has(path)) errors.set(id, r.failed.get(path))
      else if (r.notFound.has(path)) again.push(id)
    }
    return again
  }
  const ids = [...paths.keys()]
  const gone = take(await c.getTagsSafe([...new Set(paths.values())]), ids)
  const moved: string[] = []
  for (const id of gone) {
    try { const np = await relink(c, id); if (np) { paths.set(id, np); moved.push(id) } }
    catch (e) { errors.set(id, e) }
  }
  if (moved.length) for (const id of take(await c.getTagsSafe(moved.map((id) => paths.get(id)!)), moved)) errors.set(id, new Error('File not found in Dropbox (it moved again?) — try again'))
  return { tags, errors }
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
  if (missing.has(p.id)) throw new MissingFileError(p.name)
  const cur = (photos.get(p.id) ?? p).dropbox?.path
  if (cur && cur.startsWith('/')) return cur
  const path = await relink(c, p.id)
  if (!path) throw new MissingFileError(p.name)
  return path
}

export async function importNativeTags(ids?: string[]): Promise<string[]> {
  const c = activeDropbox(); if (!c) return []
  // local edits not yet in Dropbox win: write them first, and don't re-import a photo that is still queued
  const want = ids ?? [...photos.keys()]
  if (want.some((id) => dirty.has(id) || inflight.has(id))) await flush(true)
  const list = want.filter((id) => !dirty.has(id) && !inflight.has(id)).map((id) => photos.get(id)).filter((p): p is Photo => !!p?.dropbox)
  if (!list.length) return []
  const paths = new Map<string, string>()
  const readErrors: unknown[] = []
  relinked.clear()
  for (const p of list) {
    try { paths.set(p.id, await tagPath(c, p)) }
    catch (e) { if (!(e instanceof MissingFileError)) readErrors.push(e) }
  }
  // one moved/deleted file no longer aborts the import for the whole library (1.0.28)
  const got = paths.size ? await readTags(c, paths) : { tags: new Map<string, string[]>(), errors: new Map<string, unknown>() }
  readErrors.push(...got.errors.values())
  if (readErrors.length) onReadError?.(readErrors[0], readErrors.length)
  const changed: string[] = [...relinked]
  for (const p0 of list) {
    const p = photos.get(p0.id); if (!p) continue
    const read = got.tags.get(p.id)
    if (!read) continue // not read this time (deleted, or a read error): leave its tags alone
    const native = read.filter((t) => toDropboxTag(t) === t && t.length > 0)
    const prev = owned.get(p.id) ?? []
    let next = applyRemoteRemovals(p, prev.filter((t) => !native.includes(t)))
    // a suppressed tag that is back on the file was re-added in Dropbox
    if (next.dropboxRemoved?.some((t) => native.includes(t))) next = { ...next, dropboxRemoved: next.dropboxRemoved.filter((t) => !native.includes(t)) }
    const have = new Set(next.tags.map((t) => toDropboxTag(t.name)))
    // a tag Photo Tagger wrote that the app no longer has (e.g. the old long camera tag after the 1.0.28 repair) is ours to
    // remove on the next save, not a new Dropbox tag to import
    for (const t of native) if (!have.has(t) && !prev.includes(t)) { next = addTag(next, t, 'dropbox'); have.add(t) }
    const own = new Set([...prev.filter((t) => native.includes(t)), ...native.filter((t) => have.has(t))])
    owned.set(p.id, [...own].sort())
    if (next !== p) { photos.set(p.id, next); if (!changed.includes(p.id)) changed.push(p.id); touch(p.id) }
  }
  // repaired-on-load photos: write the corrected tags (and swap the old camera tag in Dropbox) through the paced queue
  for (const id of [...repaired]) if (!ids || ids.includes(id)) { repaired.delete(id); if (photos.has(id) && !missing.has(id)) touch(id) }
  emitStatus()
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
  let path = await tagPath(c, p)
  let tagsNow: string[]
  try { tagsNow = await c.getTags(path) }
  catch (e) {
    if (!isNotFoundError(e)) throw e
    // moved or renamed in Dropbox: follow the file id; deleted: list it once, don't retry
    const np = await relink(c, id)
    if (!np) throw new MissingFileError(p.name)
    path = np; p = photos.get(id) ?? p
    tagsNow = await c.getTags(path)
  }
  const current = new Set(tagsNow)
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
// a removed photo (tombstone) is never brought back by a late write from tagging/face scanning
export function putPhoto(p: Photo) { if (isRemoved(p.id)) return; photos.set(p.id, p); touch(p.id) }
export function savePhotoWithBlobs(p: Photo, b: { thumb: Blob; view: Blob }) {
  if (isRemoved(p.id)) return
  photos.set(p.id, p); thumbs.set(p.id, b.thumb); views.set(p.id, b.view); touch(p.id)
}
export function putEmbedding(id: string, e: Float32Array) { if (isRemoved(id) || !photos.has(id)) return; embeddings.set(id, e); touch(id) }
export function putFaces(fs: Face[]) { for (const f of fs) { if (isRemoved(f.photoId)) continue; faces.set(f.id, f); touch(f.photoId) } }
export function deleteFaceIds(ids: string[]) { for (const id of ids) { const f = faces.get(id); if (f) { faces.delete(id); touch(f.photoId) } } }
export function clearFaces() { const ids = new Set([...faces.values()].map((f) => f.photoId)); faces.clear(); ids.forEach(touch) }
export function setPeople(list: Person[]) { people = list; peopleDirty = true; schedule(); persistQueue() }

/**
 * Remove from the app; deletes only Photo Tagger's sidecar (and the native tags it added) in Dropbox, never the photo.
 * The photo leaves the app at once; the Dropbox side runs through the paced, retrying, persisted removal queue
 * ("Removing from app: n of N"), and the id stays tombstoned until its sidecar is confirmed deleted.
 */
export async function deletePhotos(ids: string[]) {
  for (const id of ids) {
    const p = photos.get(id); if (!p) continue
    if (p.dropbox) queueRemoval({ id, file: p.dropbox.id, name: p.name, meta: metaPath(p), path: missing.has(id) ? undefined : p.dropbox.path, tags: owned.get(id) ?? [] })
    photos.delete(id); thumbs.delete(id); views.delete(id); embeddings.delete(id)
    dirty.delete(id); retry.delete(id); failures.delete(id); missing.delete(id); syncedKey.delete(id); repaired.delete(id); relinked.delete(id)
    for (const f of [...faces.values()]) if (f.photoId === id) faces.delete(f.id)
  }
  persistRemovals(); persistQueue(); emitStatus(); schedule(0)
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
  photos.clear(); thumbs.clear(); views.clear(); embeddings.clear(); faces.clear(); people = []; dirty.clear(); peopleDirty = false; syncedKey.clear(); owned.clear(); missing.clear(); relinked.clear(); repaired.clear(); removals.clear(); rmBatch.clear(); removedLog = []; removedIds.clear(); removedLogDirty = false; retry.clear(); failures.clear(); inflight.clear(); batch.clear(); emitStatus()
}

/** Read every sidecar from Dropbox into memory. */
export async function loadFromDropbox(c: DropboxClient = activeDropbox()!) {
  if (!c) return
  // tombstones: removals still pending on this device + Dropbox's list of removed ids (other devices, reinstalls)
  restoreRemovals()
  const rj = await c.downloadRaw(REMOVED_PATH).then((b) => b?.text()).catch(() => null)
  try { for (const e of (rj ? JSON.parse(rj).removed ?? [] : []) as RemovedEntry[]) if (e?.id && !removedIds.has(e.id)) { removedLog.push(e); removedIds.add(e.id) } } catch { /* ignore */ }
  for (const r of removals.values()) if (!removedLog.some((e) => e.id === r.id)) addRemovedLog(r.id, r.file)
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
        if (isRemoved(j.photo.id)) {
          // removed from the app, but its sidecar is still there (e.g. closed mid-removal): finish removing, don't load it
          if (!removals.has(j.photo.id) && j.photo.dropbox?.id) queueRemoval({ id: j.photo.id, file: j.photo.dropbox.id, name: j.photo.name, meta: metaPath(j.photo), path: j.photo.dropbox.path, tags: j.photo.dropboxTags ?? [] })
          continue
        }
        const raw: Photo = { ...j.photo, hasOriginal: false, source: 'dropbox', relPath: undefined }
        // 1.0.28 repair: stray spaces in tag names, duplicates, old long camera tag → saved later via the paced queue
        const p = repairPhotoTags(raw)
        if (p !== raw) repaired.add(p.id)
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
  persistRemovals()
  if (removals.size || removedLogDirty) { emitStatus(); schedule(300) }
}
/** Tell listeners (People) that remote data changed — call after the photo list is refreshed. */
export const notifyRemote = emit
