/**
 * Storage facade: IndexedDB in the browser/PWA, on-disk library in Tauri desktop.
 * Call sites import from here so the web build keeps working unchanged.
 */
import { isDesktop } from './platform'
import * as idb from './db'
import * as desk from './desktopDb'
import * as remote from './remote'
import type { Face, Person, Photo } from './types'
import { repairPhotoTags } from './tags'

const local = () => (isDesktop() ? desk : idb)
const isRemote = (p: Photo) => remote.isRemotePhoto(p)
const remoteFace = (f: Face) => remote.hasRemote(f.photoId)

export async function allPhotos(): Promise<Photo[]> {
  // 1.0.28 load repair (stray spaces in tag names, duplicate tags, old long camera tag); saved back only when changed
  const ps = (await local().allPhotos()).map((p) => { const r = repairPhotoTags(p); if (r !== p) void local().putPhoto(r).catch(() => {}); return r })
  return [...ps, ...remote.remotePhotos()]
}
export async function putPhoto(p: Photo): Promise<void> {
  if (isRemote(p)) return remote.putPhoto(p)
  return local().putPhoto(p)
}
export async function savePhotoWithBlobs(p: Photo, b: { thumb: Blob; view: Blob; original?: Blob }): Promise<void> {
  // Dropbox-backed photos: memory for this session + metadata sidecar in Dropbox; nothing local
  if (isRemote(p)) return remote.savePhotoWithBlobs(p, b)
  if (isDesktop()) {
    const saved = await desk.savePhotoWithBlobs(p, b)
    // Keep caller’s object in sync with disk (relPath, hasOriginal)
    Object.assign(p, saved)
    return
  }
  return idb.savePhotoWithBlobs(p, b)
}
export async function getBlob(store: 'thumbs' | 'views' | 'originals', id: string) {
  if (remote.hasRemote(id)) return remote.getBlob(store, id)
  return local().getBlob(store, id)
}
export async function putEmbedding(id: string, e: Float32Array) {
  if (remote.hasRemote(id)) return remote.putEmbedding(id, e)
  return local().putEmbedding(id, e)
}
export async function allEmbeddings() {
  const m = await local().allEmbeddings()
  for (const [k, v] of remote.remoteEmbeddings()) m.set(k, v)
  return m
}
export async function deletePhotos(ids: string[]) {
  const r = ids.filter((id) => remote.hasRemote(id))
  const l = ids.filter((id) => !remote.hasRemote(id))
  if (r.length) await remote.deletePhotos(r)
  if (l.length) await local().deletePhotos(l)
}
export async function clearAll() {
  remote.clearMemory() // the Dropbox metadata itself is left alone
  return local().clearAll()
}
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const v = await local().kvGet<T>(key)
  if (key === 'people') {
    const rp = remote.remotePeople()
    if (!rp.length) return v
    const byId = new Map<string, Person>()
    for (const p of [...((v as Person[] | undefined) ?? []), ...rp]) byId.set(p.id, p)
    return [...byId.values()] as T
  }
  return v
}
export async function kvSet(key: string, value: unknown) {
  if (key === 'people' && Array.isArray(value)) {
    // People named on Dropbox photos live in Dropbox; only people used by local photos stay local
    const list = value as Person[]
    const remoteIds = new Set(remote.remoteFaces().map((f) => f.personId).filter(Boolean))
    const localFaces = await local().allFaces()
    const localIds = new Set(localFaces.map((f) => f.personId).filter(Boolean))
    if (remote.remotePhotos().length || remote.remotePeople().length) {
      remote.setPeople(list.filter((p) => remoteIds.has(p.id) || !localIds.has(p.id)))
      return local().kvSet(key, list.filter((p) => localIds.has(p.id)))
    }
  }
  return local().kvSet(key, value)
}
export async function allFaces(): Promise<Face[]> {
  return [...(await local().allFaces()), ...remote.remoteFaces()]
}
export async function putFaces(fs: Face[]) {
  const r = fs.filter(remoteFace), l = fs.filter((f) => !remoteFace(f))
  if (r.length) remote.putFaces(r)
  if (l.length) await local().putFaces(l)
}
export async function clearFaces() {
  remote.clearFaces()
  return local().clearFaces()
}
export async function deleteFaceIds(ids: string[]) {
  const rset = new Set(remote.remoteFaces().map((f) => f.id))
  const r = ids.filter((id) => rset.has(id)), l = ids.filter((id) => !rset.has(id))
  if (r.length) remote.deleteFaceIds(r)
  if (l.length) await local().deleteFaceIds(l)
}

export { isDesktop }
export { getLibraryPath, pickLibraryFolder, clearLibraryFolder, importBytes, isPortable, useLibraryBesideApp } from './desktopDb'
