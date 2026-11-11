// Dropbox as the library: OAuth 2 (PKCE, public client — no app secret) + the HTTP API.
// Docs: https://developers.dropbox.com/oauth-guide · https://www.dropbox.com/developers/documentation/http/documentation
// Tokens live only in local storage (IndexedDB / the desktop library's kv), never on a server.
import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from './platform'
import { backoffMs, isTransientDropboxError } from './dbxRetry'
export { backoffMs, isTransientDropboxError }

export const ENV_DROPBOX_KEY: string = (import.meta.env.VITE_DROPBOX_APP_KEY as string | undefined) ?? ''

/**
 * Scopes. files.content.write is needed only to write Photo Tagger's own metadata files
 * (tags / faces) under /.photo-tagger/ in the user's Dropbox. files.metadata.write is used only for Dropbox's native
 * file tags (files/tags/add|remove) so tags are searchable in Dropbox. Photo bytes are never modified or deleted.
 */
export const DROPBOX_SCOPES = ['account_info.read', 'files.metadata.read', 'files.metadata.write', 'files.content.read', 'files.content.write'] as const
/** Folder inside the user's Dropbox that holds Photo Tagger's metadata (one JSON sidecar per photo). */
export const META_ROOT = '/.photo-tagger'
/** Fixed loopback port for the Windows app's OAuth return (register http://127.0.0.1:53682/ in the Dropbox console). */
export const DESKTOP_REDIRECT_PORT = 53682
export const DESKTOP_REDIRECT_URI = `http://127.0.0.1:${DESKTOP_REDIRECT_PORT}/`
export const WEB_REDIRECT_URI = 'https://cdrjohnson.github.io/photo-tagger/'

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize'
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'
const API = 'https://api.dropboxapi.com/2'
const CONTENT = 'https://content.dropboxapi.com/2'
const PENDING_KEY = 'pt.dropbox.pkce'

export interface DropboxSession {
  accessToken: string
  refreshToken: string
  /** epoch ms */
  expiresAt: number
  accountId?: string
  name?: string
  email?: string
}

export interface DropboxFolder { kind: 'folder'; id: string; name: string; path: string; pathLower: string }
export interface DropboxFile {
  kind: 'file'; id: string; name: string; path: string; pathLower: string
  rev: string; size: number; contentHash?: string; clientModified?: string
  /** when the photo/video was taken, from Dropbox's media info (if Dropbox has it) */
  takenAt?: string
}
/** The date Photo Tagger uses to sort / filter a Dropbox file before adding it (no download): time taken, else modified, else a date in the name. ms, or 0 when unknown. */
export function dropboxFileDate(f: Pick<DropboxFile, 'takenAt' | 'clientModified' | 'name'>): number {
  for (const s of [f.takenAt, f.clientModified]) { const t = s ? Date.parse(s) : NaN; if (Number.isFinite(t)) return t }
  const m = f.name.match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/)
  if (m) { const t = Date.UTC(+m[1], +m[2] - 1, +m[3]); if (Number.isFinite(t) && +m[1] > 1900) return t }
  return 0
}
export type DropboxAddOrder = 'name' | 'oldest' | 'newest'
/** Order for "Add next …": name (path), oldest first or newest first (undated files last). */
export function orderDropboxFiles<T extends DropboxFile>(files: T[], order: DropboxAddOrder = 'name'): T[] {
  const byPath = (a: T, b: T) => (a.pathLower < b.pathLower ? -1 : a.pathLower > b.pathLower ? 1 : 0)
  if (order === 'name') return [...files].sort(byPath)
  const d = new Map(files.map((f) => [f.id, dropboxFileDate(f)]))
  return [...files].sort((a, b) => {
    const x = d.get(a.id)!, y = d.get(b.id)!
    if (!x !== !y) return x ? -1 : 1
    return (order === 'oldest' ? x - y : y - x) || byPath(a, b)
  })
}
export type DropboxEntry = DropboxFolder | DropboxFile

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i
/** Images the browser can decode (HEIC/TIFF are skipped). */
export const isDropboxImage = (name: string) => IMAGE_EXT.test(name)
const VIDEO_EXT = /\.(mp4|mov|m4v|avi|mkv|webm|wmv|mpe?g)$/i
/** Movies: tagged from Dropbox's preview frame only — the video file itself is never downloaded. */
export const isDropboxVideo = (name: string) => VIDEO_EXT.test(name)
export const isDropboxMedia = (name: string) => isDropboxImage(name) || isDropboxVideo(name)

/** The redirect URI this copy of the app uses (must be registered exactly in the Dropbox app console). */
export function redirectUri(): string {
  if (isDesktop()) return DESKTOP_REDIRECT_URI
  const path = location.pathname.replace(/index\.html$/, '')
  return `${location.origin}${path.endsWith('/') ? path : path + '/'}`
}

// ---------- PKCE ----------
function b64url(bytes: Uint8Array) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function randomString(n = 64) {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  return b64url(a).slice(0, n) // [A-Za-z0-9-_], 43..128 chars as PKCE requires
}
async function challengeFor(verifier: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return b64url(new Uint8Array(d))
}

async function authorizeUrl(appKey: string, state: string, verifier: string, redirect: string) {
  const q = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
    redirect_uri: redirect,
    token_access_type: 'offline',
    scope: DROPBOX_SCOPES.join(' '),
    state,
  })
  return `${AUTH_URL}?${q}`
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new DropboxError(`Dropbox sign-in failed: ${j.error_description || j.error || r.status}${r.status === 400 || r.status === 401 ? ' — connect again in Settings → Dropbox' : ''}`, r.status === 400 ? 401 : r.status)
  return j
}

async function exchangeCode(appKey: string, code: string, verifier: string, redirect: string): Promise<DropboxSession> {
  const j = await tokenRequest({ grant_type: 'authorization_code', code, client_id: appKey, code_verifier: verifier, redirect_uri: redirect })
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? '',
    expiresAt: Date.now() + (Number(j.expires_in) || 14_400) * 1000,
    accountId: j.account_id,
  }
}

/**
 * Begin sign-in. Web: navigates to dropbox.com and returns never (finish with completeWebRedirect on reload).
 * Desktop: opens the system browser, waits on the 127.0.0.1 loopback for the code, and returns the session.
 */
export async function startDropboxAuth(appKey: string): Promise<DropboxSession | null> {
  const verifier = randomString(64)
  const state = randomString(24)
  const redirect = redirectUri()
  const url = await authorizeUrl(appKey, state, verifier, redirect)
  if (isDesktop()) {
    const query = await invoke<string>('dropbox_oauth_loopback', { authUrl: url, port: DESKTOP_REDIRECT_PORT })
    const p = new URLSearchParams(query)
    if (p.get('error')) throw new Error(`Dropbox sign-in cancelled: ${p.get('error_description') || p.get('error')}`)
    if (p.get('state') !== state || !p.get('code')) throw new Error('Dropbox sign-in did not complete (state mismatch).')
    return exchangeCode(appKey, p.get('code')!, verifier, redirect)
  }
  localStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, redirect, appKey }))
  location.assign(url)
  return null
}

/** Web: if this page load is Dropbox's redirect back, exchange the code and clean the URL. */
export async function completeWebRedirect(): Promise<DropboxSession | 'error' | null> {
  if (isDesktop()) return null
  const u = new URL(location.href)
  const code = u.searchParams.get('code')
  const state = u.searchParams.get('state')
  const err = u.searchParams.get('error')
  if (!state || (!code && !err)) return null
  const raw = localStorage.getItem(PENDING_KEY)
  const pending = raw ? JSON.parse(raw) as { verifier: string; state: string; redirect: string; appKey: string } : null
  for (const k of ['code', 'state', 'error', 'error_description']) u.searchParams.delete(k)
  history.replaceState(null, '', u.pathname + (u.search || '') + u.hash)
  localStorage.removeItem(PENDING_KEY)
  if (!pending || pending.state !== state) return null
  if (err || !code) return 'error'
  return exchangeCode(pending.appKey, code, pending.verifier, pending.redirect)
}

// ---------- API client ----------
/** Header-safe JSON for Dropbox-API-Arg (non-ASCII must be \u-escaped). */
const headerJson = (o: unknown) => JSON.stringify(o).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

export class DropboxError extends Error {
  constructor(message: string, public status: number) { super(message) }
}
/** Dropbox 409 path/not_found (or path_lookup/not_found): the file is not at that path (moved, renamed or deleted). */
export const isNotFoundError = (e: any) => Number(e?.status) === 409 && /not_found/.test(String(e?.message ?? ''))

const RPC_TIMEOUT_MS = 60_000
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })
}

export class DropboxClient {
  constructor(
    public appKey: string,
    public session: DropboxSession,
    private onSession: (s: DropboxSession) => void,
  ) {}

  private refreshing: Promise<void> | null = null
  async refresh() {
    if (!this.session.refreshToken) throw new DropboxError('Dropbox session expired — connect again in Settings → Dropbox.', 401)
    this.refreshing ??= (async () => {
      try {
        const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: this.session.refreshToken, client_id: this.appKey })
        this.session = { ...this.session, accessToken: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 14_400) * 1000 }
        this.onSession(this.session)
      } finally { this.refreshing = null }
    })()
    return this.refreshing
  }

  /** Adaptive throttle: after a 429 every request from this client waits until Dropbox's Retry-After has passed. */
  private pauseUntil = 0
  /** How many times one request is retried for transient errors before the caller (e.g. the write queue) takes over. */
  maxAttempts = 6

  private async call(url: string, init: (token: string) => RequestInit, signal?: AbortSignal, timeoutMs = 0): Promise<Response> {
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      const pause = this.pauseUntil - Date.now()
      if (pause > 0) await sleep(pause, signal)
      if (Date.now() > this.session.expiresAt - 60_000) await this.refresh()
      let r: Response
      const ctl = timeoutMs ? new AbortController() : null
      const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0
      const onAbort = () => ctl?.abort()
      signal?.addEventListener('abort', onAbort)
      try {
        r = await fetch(url, { ...init(this.session.accessToken), signal: ctl ? ctl.signal : signal })
      } catch (e: any) {
        if (signal?.aborted) throw e
        // network error / our own timeout: transient
        const err = new DropboxError(ctl?.signal.aborted ? 'Dropbox request timed out' : `Network error talking to Dropbox (${e?.message || e})`, 0)
        if (attempt + 1 >= this.maxAttempts) throw err
        await sleep(backoffMs(attempt), signal); continue
      } finally { if (t) clearTimeout(t); signal?.removeEventListener('abort', onAbort) }
      // token expired mid-way (e.g. during a long write queue): refresh once and retry
      if (r.status === 401 && !refreshed) { refreshed = true; await this.refresh(); attempt--; continue }
      if (r.ok) return r
      const text = await r.text().catch(() => '')
      const err = new DropboxError(`Dropbox request failed (${r.status})${text ? `: ${text.slice(0, 160)}` : ''}`, r.status)
      if (!isTransientDropboxError(err) || attempt + 1 >= this.maxAttempts) throw err
      // honour Retry-After (no low cap; at most 15 minutes) and slow every request down while rate limited
      const ra = Number(r.headers.get('retry-after'))
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 15 * 60_000) : backoffMs(attempt)
      if (r.status === 429 || /too_many_write_operations|too_many_requests/.test(text)) this.pauseUntil = Math.max(this.pauseUntil, Date.now() + wait)
      await sleep(wait, signal)
    }
  }

  async rpc<T>(endpoint: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const r = await this.call(`${API}/${endpoint}`, (tok) => ({
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, ...(body === null ? {} : { 'Content-Type': 'application/json' }) },
      body: body === null ? undefined : JSON.stringify(body),
    }), signal, RPC_TIMEOUT_MS)
    return r.json() as Promise<T>
  }

  async account(): Promise<{ name: string; email: string; accountId: string }> {
    const j = await this.rpc<any>('users/get_current_account', null)
    return { name: j?.name?.display_name ?? '', email: j?.email ?? '', accountId: j?.account_id ?? '' }
  }

  /** List one folder (all pages). path '' = root. recursive lists every file below. */
  async listFolder(path: string, opts: { recursive?: boolean; signal?: AbortSignal } = {}): Promise<DropboxEntry[]> {
    const out: DropboxEntry[] = []
    let j = await this.rpc<any>('files/list_folder', { path, recursive: !!opts.recursive, include_media_info: true, limit: 2000 }, opts.signal)
    for (;;) {
      for (const e of j.entries ?? []) {
        if (e['.tag'] === 'folder') out.push({ kind: 'folder', id: e.id, name: e.name, path: e.path_display ?? e.path_lower, pathLower: e.path_lower })
        else if (e['.tag'] === 'file') out.push({
          kind: 'file', id: e.id, name: e.name, path: e.path_display ?? e.path_lower, pathLower: e.path_lower,
          rev: e.rev, size: e.size, contentHash: e.content_hash, clientModified: e.client_modified,
          takenAt: e.media_info?.metadata?.time_taken || undefined,
        })
      }
      if (!j.has_more) break
      j = await this.rpc<any>('files/list_folder/continue', { cursor: j.cursor }, opts.signal)
    }
    return out
  }

  /** Download a file's bytes into memory (never written to disk by this app). */
  async download(f: { id: string; name: string; clientModified?: string }, signal?: AbortSignal): Promise<File> {
    const r = await this.call(`${CONTENT}/files/download`, (tok) => ({
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Dropbox-API-Arg': headerJson({ path: f.id }) },
    }), signal)
    const blob = await r.blob()
    const type = blob.type && blob.type.startsWith('image/') ? blob.type : guessType(f.name)
    const lm = f.clientModified ? Date.parse(f.clientModified) : 0
    return new File([blob], f.name, { type, lastModified: Number.isFinite(lm) ? lm : 0 })
  }

  /** Download any file by path or id as raw bytes. Returns null when it does not exist. */
  async downloadRaw(path: string, signal?: AbortSignal): Promise<Blob | null> {
    try {
      const r = await this.call(`${CONTENT}/files/download`, (tok) => ({
        method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Dropbox-API-Arg': headerJson({ path }) },
      }), signal)
      return await r.blob()
    } catch (e: any) {
      if (e?.status === 409) return null
      throw e
    }
  }

  /** Dropbox-rendered thumbnail (JPEG). size e.g. 'w256h256' or 'w2048h1536'. */
  async thumbnail(id: string, size: string): Promise<Blob | null> {
    try {
      const r = await this.call(`${CONTENT}/files/get_thumbnail_v2`, (tok) => ({
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Dropbox-API-Arg': headerJson({ resource: { '.tag': 'path', path: id }, format: 'jpeg', size, mode: 'fitone_bestfit' }) },
      }))
      return await r.blob()
    } catch { return null }
  }

  /** Dropbox preview image of a file (photo or video): by id, then by '/…' path. Never the file itself. */
  async preview(f: { id: string; path?: string }, size: string): Promise<Blob | null> {
    return (await this.thumbnail(f.id, size)) ?? (f.path?.startsWith('/') ? await this.thumbnail(f.path, size) : null)
  }

  /** Write one of Photo Tagger's own metadata files. Refuses any path outside META_ROOT. */
  async writeMeta(path: string, data: Blob | string) {
    if (!path.startsWith(META_ROOT + '/')) throw new Error('refusing to write outside Photo Tagger metadata folder')
    await this.call(`${CONTENT}/files/upload`, (tok) => ({
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson({ path, mode: 'overwrite', mute: true, autorename: false }) },
      body: data,
    }))
  }

  /** Delete one of Photo Tagger's own metadata files (never a photo). */
  async deleteMeta(path: string) {
    if (!path.startsWith(META_ROOT + '/')) throw new Error('refusing to delete outside Photo Tagger metadata folder')
    // already gone = done; other 409s (e.g. too_many_write_operations) are real errors the removal queue retries
    try { await this.rpc('files/delete_v2', { path }) } catch (e: any) { if (!isNotFoundError(e)) throw e }
  }

  /** List a folder; [] when it does not exist yet. */
  async listIfExists(path: string): Promise<DropboxEntry[]> {
    try { return await this.listFolder(path) } catch (e: any) { if (e?.status === 409) return []; throw e }
  }

  /** Native Dropbox tags currently on a file (any source). */
  async getTags(path: string): Promise<string[]> {
    const j = await this.rpc<any>('files/tags/get', { paths: [path] })
    return this.norm(path, j?.paths_to_tags?.[0]?.tags)
  }
  /** Current path of a file id (files/get_metadata). The Tags API only accepts real '/…' paths, never 'id:…'. */
  async pathFor(id: string): Promise<string> {
    const j = await this.rpc<any>('files/get_metadata', { path: id })
    const path = j?.path_display ?? j?.path_lower
    if (!path || !String(path).startsWith('/')) throw new Error('Dropbox did not return a path for ' + id)
    return path
  }
  /**
   * Where a file is now, by its Dropbox id (ids survive moves and renames). null when the file was deleted
   * (get_metadata says not_found / deleted). Other errors throw.
   */
  async locate(id: string): Promise<{ path: string; name: string } | null> {
    try {
      const j = await this.rpc<any>('files/get_metadata', { path: id, include_deleted: false })
      if (!j || j['.tag'] === 'deleted') return null
      const path = j.path_display ?? j.path_lower
      if (!path || !String(path).startsWith('/')) return null
      return { path, name: j.name ?? String(path).split('/').pop() }
    } catch (e: any) {
      if (isNotFoundError(e)) return null
      throw e
    }
  }
  /** Native tags for many files at once (batched). Map keyed by the path/id passed in. Throws if any path is gone — use getTagsSafe. */
  async getTagsMany(paths: string[]): Promise<Map<string, string[]>> {
    const r = await this.getTagsSafe(paths)
    if (r.failed.size) throw [...r.failed.values()][0]
    if (r.notFound.size) throw new DropboxError('Dropbox request failed (409): path/not_found/', 409)
    return r.tags
  }
  /**
   * Native tags for many files, 20 paths per request. Dropbox rejects a whole request (409 path/not_found) when one
   * path in it no longer exists, so such a batch is split in halves until the missing path(s) are isolated —
   * the other paths still get their tags. Other errors only affect their own batch (reported in `failed`).
   */
  async getTagsSafe(paths: string[]): Promise<{ tags: Map<string, string[]>; notFound: Set<string>; failed: Map<string, unknown> }> {
    const tags = new Map<string, string[]>(), notFound = new Set<string>(), failed = new Map<string, unknown>()
    const run = async (chunk: string[]): Promise<void> => {
      try {
        const j = await this.rpc<any>('files/tags/get', { paths: chunk })
        ;(j?.paths_to_tags ?? []).forEach((pt: any, k: number) => { tags.set(chunk[k] ?? pt.path, this.norm(chunk[k] ?? pt.path, pt.tags)) })
      } catch (e: any) {
        if (!isNotFoundError(e)) { for (const x of chunk) failed.set(x, e); return }
        if (chunk.length === 1) { notFound.add(chunk[0]); return }
        const mid = Math.ceil(chunk.length / 2)
        await run(chunk.slice(0, mid)); await run(chunk.slice(mid))
      }
    }
    for (let i = 0; i < paths.length; i += 20) await run(paths.slice(i, i + 20))
    return { tags, notFound, failed }
  }
  /** Add / remove one native Dropbox tag (metadata only — the file's bytes are untouched). */
  async addTag(path: string, tag: string) { await this.rpc('files/tags/add', { path, tag_text: tag }) }
  /** normalized tag → exact text on the file, per path (so removing "family_trip" removes "Family Trip") */
  private rawTags = new Map<string, string>()
  /** Native count before normalizing / deduplicating names (the 20-tag cap counts native tags). */
  private nativeTagCounts = new Map<string, number>()
  tagCount(path: string): number { return this.nativeTagCounts.get(path) ?? 0 }
  private norm(path: string, tags: any): string[] {
    this.nativeTagCounts.set(path, (tags ?? []).length)
    const out: string[] = []
    for (const t of tags ?? []) {
      const raw = String(t?.tag_text ?? ''); const n = toDropboxTagText(raw)
      if (!n) continue
      if (raw !== n) this.rawTags.set(path + '\n' + n, raw)
      if (!out.includes(n)) out.push(n)
    }
    return out
  }
  async removeTag(path: string, tag: string) {
    const raw = this.rawTags.get(path + '\n' + tag)
    if (raw) { await this.removeTag0(path, raw); this.rawTags.delete(path + '\n' + tag) }
    await this.removeTag0(path, tag)
  }
  private async removeTag0(path: string, tag: string) {
    try { await this.rpc('files/tags/remove', { path, tag_text: tag }) } catch (e: any) { if (!(e?.status === 409 && /tag_not_present/.test(e.message))) throw e }
  }

  /** Best-effort token revoke on Disconnect (does not touch any file). */
  async revoke() {
    try { await fetch(`${API}/auth/token/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${this.session.accessToken}` } }) } catch { /* offline */ }
  }
}

function guessType(name: string) {
  const e = name.split('.').pop()?.toLowerCase()
  return e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : e === 'gif' ? 'image/gif' : e === 'bmp' ? 'image/bmp' : e === 'avif' ? 'image/avif' : 'image/jpeg'
}

// The connected client, so export/save can re-fetch originals on demand without storing them.
let active: DropboxClient | null = null
export const setActiveDropbox = (c: DropboxClient | null) => { active = c }
export const activeDropbox = () => active

/** Fetch the full original of a Dropbox-backed photo for export (not stored). */
/** A tag name the way Dropbox search / Photo Tagger write it ("Family Trip", "#family-trip" → family_trip) */
export function toDropboxTagText(name: string): string {
  const t = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return t.slice(0, 32).replace(/_$/, '')
}
export async function fetchDropboxOriginal(p: { name: string; dropbox?: { id: string } }): Promise<Blob | undefined> {
  if (!p.dropbox || !active) return undefined
  if (isDropboxVideo(p.name)) return undefined // never pull a whole movie
  try { return await active.download({ id: p.dropbox.id, name: p.name }) } catch { return undefined }
}
