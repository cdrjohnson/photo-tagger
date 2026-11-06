/** Save tagged photos to a local folder (File System Access API) or as a ZIP download. */
import * as DB from './db'
import { toCSV, toJSON } from './exportImport'
import type { CustomLabel, Photo, Settings } from './types'

export const FOLDER_KV = 'saveFolder'
export type DirHandle = FileSystemDirectoryHandle

export const canPickFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window

export async function pickFolder(): Promise<DirHandle> {
  // @ts-expect-error showDirectoryPicker is Chromium-only
  const h: DirHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'photo-tagger-save' })
  await DB.kvSet(FOLDER_KV, h)
  return h
}

export async function getSavedFolder(): Promise<DirHandle | null> {
  const h = await DB.kvGet<DirHandle>(FOLDER_KV)
  return h ?? null
}

export async function clearSavedFolder() {
  await DB.kvSet(FOLDER_KV, null)
}

/** Returns true if we can write; may prompt the user. */
export async function ensurePermission(h: DirHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' as const }
  // queryPermission / requestPermission exist on FileSystemHandle in Chromium
  const q = await (h as unknown as { queryPermission(o: { mode: string }): Promise<PermissionState> }).queryPermission(opts)
  if (q === 'granted') return true
  const r = await (h as unknown as { requestPermission(o: { mode: string }): Promise<PermissionState> }).requestPermission(opts)
  return r === 'granted'
}

function safeName(name: string, used: Set<string>) {
  let n = name.replace(/[/\\?%*:|"<>]/g, '_').replace(/^\.+/, '_') || 'photo.jpg'
  const key = (s: string) => s.toLowerCase()
  if (!used.has(key(n))) { used.add(key(n)); return n }
  const i = n.lastIndexOf('.')
  const base = i > 0 ? n.slice(0, i) : n
  const ext = i > 0 ? n.slice(i) : ''
  let k = 2
  while (used.has(key(`${base}-${k}${ext}`))) k++
  n = `${base}-${k}${ext}`
  used.add(key(n))
  return n
}

async function photoBlob(p: Photo): Promise<Blob> {
  if (p.hasOriginal) {
    const o = await DB.getBlob('originals', p.id)
    if (o) return o
  }
  const v = await DB.getBlob('views', p.id)
  if (!v) throw new Error(`No image data for ${p.name}`)
  return v
}

function sidecar(p: Photo, savedAs: string) {
  return JSON.stringify({
    app: 'photo-tagger',
    savedAs,
    name: p.name,
    size: p.size,
    takenAt: p.takenAt ? new Date(p.takenAt).toISOString() : undefined,
    camera: p.camera,
    latitude: p.gps?.lat,
    longitude: p.gps?.lon,
    source: p.source,
    width: p.width,
    height: p.height,
    tags: p.tags,
    rejected: p.rejected.length ? p.rejected : undefined,
    duplicateOf: p.duplicateOf,
  }, null, 2)
}

async function writeFile(dir: DirHandle, name: string, data: Blob | string) {
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(typeof data === 'string' ? new Blob([data], { type: 'application/json' }) : data)
  await w.close()
}

export interface SaveResult { ok: number; failed: number; folderName?: string }

/** Write photos + sidecars + library JSON/CSV into the chosen folder. */
export async function saveToFolder(
  dir: DirHandle,
  photos: Photo[],
  settings: Settings,
  custom: CustomLabel[],
): Promise<SaveResult> {
  if (!(await ensurePermission(dir))) throw new Error('Permission to write to that folder was not granted.')
  const photosDir = await dir.getDirectoryHandle('photos', { create: true })
  const used = new Set<string>()
  let ok = 0, failed = 0
  for (const p of photos) {
    try {
      const name = safeName(p.name, used)
      await writeFile(photosDir, name, await photoBlob(p))
      await writeFile(photosDir, `${name}.json`, sidecar(p, name))
      ok++
    } catch {
      failed++
    }
  }
  await writeFile(dir, 'photo-tagger.json', toJSON(photos, settings, custom))
  await writeFile(dir, 'photo-tagger.csv', toCSV(photos))
  return { ok, failed, folderName: dir.name }
}

/** Save a single newly tagged photo into an already-permitted folder (auto-save). */
export async function saveOneToFolder(dir: DirHandle, p: Photo): Promise<void> {
  if (!(await ensurePermission(dir))) return
  const photosDir = await dir.getDirectoryHandle('photos', { create: true })
  // append id prefix if a same-named file already exists with different content — keep it simple: always use safe unique name based on listing
  const used = new Set<string>()
  try {
    // @ts-expect-error async iterator
    for await (const [n] of photosDir.entries()) used.add(String(n).toLowerCase())
  } catch { /* listing may fail; fall through */ }
  const name = safeName(p.name, used)
  await writeFile(photosDir, name, await photoBlob(p))
  await writeFile(photosDir, `${name}.json`, sidecar(p, name))
}

// ---------- ZIP fallback (store method; images are already compressed) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()
function crc32(buf: Uint8Array) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function u16(n: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b }
function u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }

function zipStore(files: { name: string; data: Uint8Array }[]): Blob {
  const parts: BlobPart[] = []
  const central: BlobPart[] = []
  let offset = 0
  for (const f of files) {
    const name = new TextEncoder().encode(f.name)
    const crc = crc32(f.data)
    const local = new Blob([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), name, f.data as BlobPart])
    parts.push(local)
    central.push(new Blob([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]))
    offset += 30 + name.length + f.data.length
  }
  const centralBlob = new Blob(central)
  const end = new Blob([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralBlob.size), u32(offset), u16(0)])
  return new Blob([...parts, centralBlob, end], { type: 'application/zip' })
}

export async function buildZip(photos: Photo[], settings: Settings, custom: CustomLabel[]): Promise<Blob> {
  const used = new Set<string>()
  const files: { name: string; data: Uint8Array }[] = []
  for (const p of photos) {
    const name = safeName(p.name, used)
    const blob = await photoBlob(p)
    files.push({ name: `photos/${name}`, data: new Uint8Array(await blob.arrayBuffer()) })
    files.push({ name: `photos/${name}.json`, data: new TextEncoder().encode(sidecar(p, name)) })
  }
  files.push({ name: 'photo-tagger.json', data: new TextEncoder().encode(toJSON(photos, settings, custom)) })
  files.push({ name: 'photo-tagger.csv', data: new TextEncoder().encode(toCSV(photos)) })
  return zipStore(files)
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
