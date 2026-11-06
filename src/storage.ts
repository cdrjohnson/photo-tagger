/**
 * Storage facade: IndexedDB in the browser/PWA, on-disk library in Tauri desktop.
 * Call sites import from here so the web build keeps working unchanged.
 */
import { isDesktop } from './platform'
import * as idb from './db'
import * as desk from './desktopDb'
import type { Face, Photo } from './types'

export async function allPhotos(): Promise<Photo[]> {
  return isDesktop() ? desk.allPhotos() : idb.allPhotos()
}
export async function putPhoto(p: Photo): Promise<void> {
  return isDesktop() ? desk.putPhoto(p) : idb.putPhoto(p)
}
export async function savePhotoWithBlobs(p: Photo, b: { thumb: Blob; view: Blob; original?: Blob }): Promise<void> {
  if (isDesktop()) {
    const saved = await desk.savePhotoWithBlobs(p, b)
    // Keep caller’s object in sync with disk (relPath, hasOriginal)
    Object.assign(p, saved)
    return
  }
  return idb.savePhotoWithBlobs(p, b)
}
export async function getBlob(store: 'thumbs' | 'views' | 'originals', id: string) {
  return isDesktop() ? desk.getBlob(store, id) : idb.getBlob(store, id)
}
export async function putEmbedding(id: string, e: Float32Array) {
  return isDesktop() ? desk.putEmbedding(id, e) : idb.putEmbedding(id, e)
}
export async function allEmbeddings() {
  return isDesktop() ? desk.allEmbeddings() : idb.allEmbeddings()
}
export async function deletePhotos(ids: string[]) {
  return isDesktop() ? desk.deletePhotos(ids) : idb.deletePhotos(ids)
}
export async function clearAll() {
  return isDesktop() ? desk.clearAll() : idb.clearAll()
}
export async function kvGet<T>(key: string): Promise<T | undefined> {
  return isDesktop() ? desk.kvGet<T>(key) : idb.kvGet<T>(key)
}
export async function kvSet(key: string, value: unknown) {
  return isDesktop() ? desk.kvSet(key, value) : idb.kvSet(key, value)
}
export async function allFaces(): Promise<Face[]> {
  return isDesktop() ? desk.allFaces() : idb.allFaces()
}
export async function putFaces(fs: Face[]) {
  return isDesktop() ? desk.putFaces(fs) : idb.putFaces(fs)
}
export async function clearFaces() {
  return isDesktop() ? desk.clearFaces() : idb.clearFaces()
}
export async function deleteFaceIds(ids: string[]) {
  return isDesktop() ? desk.deleteFaceIds(ids) : idb.deleteFaceIds(ids)
}

export { isDesktop }
export { getLibraryPath, pickLibraryFolder, clearLibraryFolder, importBytes } from './desktopDb'
