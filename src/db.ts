import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Photo } from './types'

interface Schema extends DBSchema {
  photos: { key: string; value: Photo }
  thumbs: { key: string; value: Blob }
  views: { key: string; value: Blob }
  originals: { key: string; value: Blob }
  embeddings: { key: string; value: Float32Array }
  kv: { key: string; value: unknown }
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null
export function db() {
  dbp ??= openDB<Schema>('photo-tagger', 1, {
    upgrade(d) {
      d.createObjectStore('photos', { keyPath: 'id' })
      d.createObjectStore('thumbs')
      d.createObjectStore('views')
      d.createObjectStore('originals')
      d.createObjectStore('embeddings')
      d.createObjectStore('kv')
    },
  })
  return dbp
}

export async function allPhotos(): Promise<Photo[]> {
  return (await db()).getAll('photos')
}
export async function putPhoto(p: Photo) {
  await (await db()).put('photos', p)
}
export async function savePhotoWithBlobs(p: Photo, b: { thumb: Blob; view: Blob; original?: Blob }) {
  const d = await db()
  const tx = d.transaction(['photos', 'thumbs', 'views', 'originals'], 'readwrite')
  tx.objectStore('photos').put(p)
  tx.objectStore('thumbs').put(b.thumb, p.id)
  tx.objectStore('views').put(b.view, p.id)
  if (b.original) tx.objectStore('originals').put(b.original, p.id)
  await tx.done
}
export async function getBlob(store: 'thumbs' | 'views' | 'originals', id: string) {
  return (await db()).get(store, id)
}
export async function putEmbedding(id: string, e: Float32Array) {
  await (await db()).put('embeddings', e, id)
}
export async function allEmbeddings(): Promise<Map<string, Float32Array>> {
  const d = await db()
  const keys = await d.getAllKeys('embeddings')
  const vals = await d.getAll('embeddings')
  return new Map(keys.map((k, i) => [k as string, vals[i]]))
}
export async function deletePhotos(ids: string[]) {
  const d = await db()
  const tx = d.transaction(['photos', 'thumbs', 'views', 'originals', 'embeddings'], 'readwrite')
  for (const id of ids) {
    for (const s of ['photos', 'thumbs', 'views', 'originals', 'embeddings'] as const) tx.objectStore(s).delete(id)
  }
  await tx.done
}
export async function clearAll() {
  const d = await db()
  const tx = d.transaction(['photos', 'thumbs', 'views', 'originals', 'embeddings', 'kv'], 'readwrite')
  for (const s of ['photos', 'thumbs', 'views', 'originals', 'embeddings', 'kv'] as const) tx.objectStore(s).clear()
  await tx.done
}
export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined
}
export async function kvSet(key: string, value: unknown) {
  await (await db()).put('kv', value, key)
}
