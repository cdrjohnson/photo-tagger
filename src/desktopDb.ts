/** Desktop (Tauri) storage: photos on disk, metadata in <library>/.photo-tagger/. */
import { invoke } from '@tauri-apps/api/core'
import type { Face, Photo } from './types'

async function blobToB64(b: Blob): Promise<string> {
  const buf = await b.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(s)
}

function b64ToBlob(b64: string, type = 'image/jpeg'): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

export async function getLibraryPath(): Promise<string | null> {
  return invoke<string | null>('library_get_path')
}

export async function pickLibraryFolder(): Promise<string> {
  return invoke<string>('library_pick')
}

export async function clearLibraryFolder(): Promise<void> {
  await invoke('library_clear')
}

export async function allPhotos(): Promise<Photo[]> {
  return invoke<Photo[]>('library_list_photos')
}

export async function putPhoto(p: Photo): Promise<void> {
  await invoke('library_put_photo', { photo: p })
}

export async function savePhotoWithBlobs(p: Photo, b: { thumb: Blob; view: Blob; original?: Blob }): Promise<Photo> {
  const thumbB64 = await blobToB64(b.thumb)
  const viewB64 = await blobToB64(b.view)
  const originalB64 = b.original ? await blobToB64(b.original) : null
  const saved = await invoke<Photo>('library_save_blobs', {
    photo: p,
    thumbB64,
    viewB64,
    originalB64,
    originalName: p.name,
  })
  return saved
}

export async function getBlob(store: 'thumbs' | 'views' | 'originals', id: string): Promise<Blob | undefined> {
  const b64 = await invoke<string | null>('library_get_blob', { store, id })
  if (!b64) return undefined
  return b64ToBlob(b64)
}

export async function putEmbedding(id: string, e: Float32Array): Promise<void> {
  await invoke('library_put_embedding', { id, values: Array.from(e) })
}

export async function allEmbeddings(): Promise<Map<string, Float32Array>> {
  const raw = await invoke<Record<string, number[]>>('library_all_embeddings')
  return new Map(Object.entries(raw).map(([k, v]) => [k, Float32Array.from(v)]))
}

export async function deletePhotos(ids: string[]): Promise<void> {
  await invoke('library_delete_photos', { ids })
}

export async function clearAll(): Promise<void> {
  await invoke('library_clear_all')
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const v = await invoke<T | null>('library_kv_get', { key })
  return v ?? undefined
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await invoke('library_kv_set', { key, value })
}

export async function allFaces(): Promise<Face[]> {
  const rows = await invoke<Array<Record<string, unknown> & { thumbB64?: string; descriptor?: number[] }>>('library_all_faces')
  return rows.map((r) => {
    const { thumbB64, descriptor, ...rest } = r
    const face = rest as unknown as Face
    face.descriptor = Float32Array.from(descriptor ?? [])
    face.thumb = thumbB64 ? b64ToBlob(thumbB64) : new Blob()
    return face
  })
}

export async function putFaces(fs: Face[]): Promise<void> {
  const payload = []
  for (const f of fs) {
    const thumbB64 = f.thumb && f.thumb.size ? await blobToB64(f.thumb) : undefined
    payload.push({
      id: f.id,
      photoId: f.photoId,
      box: f.box,
      score: f.score,
      descriptor: Array.from(f.descriptor),
      status: f.status,
      personId: f.personId,
      rejected: f.rejected,
      thumbB64,
    })
  }
  await invoke('library_put_faces', { faces: payload })
}

export async function clearFaces(): Promise<void> {
  await invoke('library_clear_faces')
}

/** Copy / download bytes into the library folder; returns relative file name. */
export async function importBytes(name: string, data: Blob | ArrayBuffer): Promise<{ relPath: string; size: number }> {
  const blob = data instanceof Blob ? data : new Blob([data])
  const dataB64 = await blobToB64(blob)
  return invoke('library_import_bytes', { name, dataB64 })
}

export async function deleteFaceIds(ids: string[]) {
  // Re-read and putFaces doesn't delete; use clear+restore via dedicated command when needed.
  // For now delete by rewriting: clear all faces of those ids through put with empty after SQL delete.
  await invoke('library_delete_face_ids', { ids })
}

export async function isPortable(): Promise<boolean> {
  return invoke<boolean>('library_is_portable')
}

export async function useLibraryBesideApp(): Promise<string> {
  return invoke<string>('library_use_beside_app')
}
