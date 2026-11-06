import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as DB from './storage'
import { faces as faceClient } from './ml/faceClient'
import { decodeImage, scaledCanvas, toBlob } from './imageUtils'
import { clusterFaces, suggestMatches, type Suggestion } from './faceLogic'
import { useLibrary } from './store'
import { normTag } from './tags'
import type { Face, Person } from './types'

const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
export const CLUSTER_THRESHOLD = 0.5

export interface People {
  ready: boolean
  faces: Face[]
  people: Person[]
  suggestions: Map<string, Suggestion>
  clusters: Face[][]
  scan: { done: number; total: number } | null
  unscanned: number
  faceUrl(f: Face): string
  scanLibrary(): Promise<void>
  nameFaces(faceIds: string[], name: string): Promise<void>
  confirm(faceIds: string[]): Promise<void>
  reject(faceIds: string[], personId: string): Promise<void>
  ignore(faceIds: string[]): Promise<void>
  rejectOnPhotos(photoIds: string[], tagName: string): Promise<void>
  rename(personId: string, name: string): Promise<void>
  merge(fromId: string, intoId: string): Promise<void>
  deletePerson(personId: string): Promise<void>
  setEnabled(on: boolean): Promise<void>
  clearFaceData(): Promise<void>
  isPersonTag(name: string): boolean
}

const Ctx = createContext<People | null>(null)
export const usePeople = () => useContext(Ctx)!

const urls = new Map<string, string>()

async function cropFace(c: HTMLCanvasElement, b: Face['box']): Promise<Blob> {
  const W = c.width, H = c.height
  const cx = (b.x + b.w / 2) * W, cy = (b.y + b.h / 2) * H
  const side = Math.min(Math.max(b.w * W, b.h * H) * 1.5, W, H)
  const sx = Math.min(Math.max(0, cx - side / 2), W - side), sy = Math.min(Math.max(0, cy - side / 2), H - side)
  const out = document.createElement('canvas')
  out.width = out.height = 160
  out.getContext('2d')!.drawImage(c, sx, sy, side, side, 0, 0, 160, 160)
  return toBlob(out, 0.85)
}

export function PeopleProvider({ children }: { children: ReactNode }) {
  const lib = useLibrary()
  const libRef = useRef(lib)
  libRef.current = lib
  const [ready, setReady] = useState(false)
  const [faces, setFacesState] = useState<Face[]>([])
  const [people, setPeopleState] = useState<Person[]>([])
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null)
  const facesRef = useRef<Face[]>([])
  const peopleRef = useRef<Person[]>([])
  const setFaces = (f: Face[]) => { facesRef.current = f; setFacesState(f) }
  const setPeople = async (p: Person[]) => { peopleRef.current = p; setPeopleState(p); await DB.kvSet('people', p) }

  useEffect(() => {
    (async () => {
      const [f, p] = await Promise.all([DB.allFaces(), DB.kvGet<Person[]>('people')])
      setFaces(f); peopleRef.current = p ?? []; setPeopleState(p ?? [])
      setReady(true)
    })()
  }, [])

  // drop faces whose photos were deleted (the DB rows are deleted together with the photo)
  useEffect(() => {
    if (!ready || !lib.ready) return
    const ids = new Set(lib.photos.map((p) => p.id))
    if (facesRef.current.some((f) => !ids.has(f.photoId))) setFaces(facesRef.current.filter((f) => ids.has(f.photoId)))
    if (!lib.photos.length && facesRef.current.length === 0 && peopleRef.current.length) {
      // a full wipe from Settings → Data also clears people
      DB.kvGet('people').then((p) => { if (!p) { peopleRef.current = []; setPeopleState([]) } })
    }
  }, [lib.photos, lib.ready, ready])

  /** Rewrite the person tags of the given photos from their confirmed faces. */
  const syncTags = useCallback(async (photoIds: string[]) => {
    const names = new Map(peopleRef.current.map((p) => [p.id, normTag(p.name)]))
    const by = new Map<string, Set<string>>()
    for (const f of facesRef.current) if (f.status === 'confirmed' && f.personId && names.has(f.personId)) {
      by.set(f.photoId, (by.get(f.photoId) ?? new Set()).add(names.get(f.personId)!))
    }
    await libRef.current.updatePhotos([...new Set(photoIds)], (p) => {
      const want = [...(by.get(p.id) ?? [])]
      const tags = p.tags.filter((t) => t.source !== 'person' && !want.includes(t.name))
      return { ...p, tags: [...tags, ...want.map((name) => ({ name, source: 'person' as const }))] }
    })
  }, [])

  const updateFaces = useCallback(async (ids: string[], fn: (f: Face) => Face) => {
    const set = new Set(ids)
    const changed: Face[] = []
    const next = facesRef.current.map((f) => { if (!set.has(f.id)) return f; const n = fn(f); changed.push(n); return n })
    await DB.putFaces(changed) // persist first so a reload right after a click never loses it
    setFaces(next)
    await syncTags(changed.map((f) => f.photoId))
  }, [syncTags])

  // ---------- detection ----------
  const scanPhoto = useCallback(async (photoId: string) => {
    const v = await DB.getBlob('views', photoId)
    if (!v) return
    const bmp = await decodeImage(v)
    const c = scaledCanvas(bmp, Math.min(1, 1024 / Math.max(bmp.width, bmp.height)))
    bmp.close()
    const det = await faceClient.detect(await createImageBitmap(c), 0.5)
    const recs: Face[] = []
    for (const d of det) {
      recs.push({ id: uid(), photoId, box: d.box, score: d.score, descriptor: d.descriptor, thumb: await cropFace(c, d.box), status: 'unknown', rejected: [] })
    }
    // replace any previous faces of this photo
    const old = facesRef.current.filter((f) => f.photoId === photoId)
    if (old.length) await DB.deleteFaceIds(old.map((f) => f.id))
    await DB.putFaces(recs)
    setFaces([...facesRef.current.filter((f) => f.photoId !== photoId), ...recs])
    await libRef.current.updatePhotos([photoId], (p) => ({ ...p, facesScanned: true, faceCount: recs.length }))
  }, [])

  useEffect(() => {
    lib.setAfterIngest(lib.settings.faceEnabled ? scanPhoto : null)
    return () => lib.setAfterIngest(null)
  }, [lib.settings.faceEnabled, lib.setAfterIngest, scanPhoto])

  const scanLibrary = useCallback(async () => {
    const todo = libRef.current.photos.filter((p) => !p.facesScanned)
    if (!todo.length) return
    setScan({ done: 0, total: todo.length })
    try {
      for (let i = 0; i < todo.length; i++) {
        await scanPhoto(todo[i].id)
        setScan({ done: i + 1, total: todo.length })
      }
    } catch (e: any) {
      libRef.current.toast(`Face detection failed: ${e.message}`, 'error')
    } finally {
      setTimeout(() => setScan(null), 800)
    }
  }, [scanPhoto])

  // ---------- naming ----------
  const personByName = (name: string) => peopleRef.current.find((p) => p.name.toLowerCase() === name.trim().toLowerCase())

  const nameFaces = useCallback(async (faceIds: string[], name: string) => {
    const n = name.trim().replace(/\s+/g, ' ')
    if (!n || !faceIds.length) return
    let p = personByName(n)
    if (!p) { p = { id: uid(), name: n, createdAt: Date.now() }; await setPeople([...peopleRef.current, p]) }
    const pid = p.id
    await updateFaces(faceIds, (f) => ({ ...f, status: 'confirmed', personId: pid, rejected: f.rejected.filter((r) => r !== pid) }))
  }, [updateFaces])

  const suggestions = useMemo(() => suggestMatches(faces, people, lib.settings.faceThreshold), [faces, people, lib.settings.faceThreshold])

  const confirm = useCallback(async (faceIds: string[]) => {
    const sug = suggestMatches(facesRef.current, peopleRef.current, libRef.current.settings.faceThreshold)
    const groups = new Map<string, string[]>()
    for (const id of faceIds) { const s = sug.get(id); if (s) groups.set(s.personId, [...(groups.get(s.personId) ?? []), id]) }
    for (const [pid, ids] of groups) await updateFaces(ids, (f) => ({ ...f, status: 'confirmed', personId: pid }))
  }, [updateFaces])

  const reject = useCallback(async (faceIds: string[], personId: string) => {
    await updateFaces(faceIds, (f) => ({
      ...f,
      status: f.status === 'ignored' ? 'ignored' : 'unknown',
      personId: undefined,
      rejected: f.rejected.includes(personId) ? f.rejected : [...f.rejected, personId],
    }))
  }, [updateFaces])

  const ignore = useCallback((faceIds: string[]) => updateFaces(faceIds, (f) => ({ ...f, status: 'ignored', personId: undefined })), [updateFaces])

  const rejectOnPhotos = useCallback(async (photoIds: string[], tagName: string) => {
    const p = peopleRef.current.find((x) => normTag(x.name) === tagName)
    if (!p) return
    const set = new Set(photoIds)
    await reject(facesRef.current.filter((f) => set.has(f.photoId) && f.personId === p.id).map((f) => f.id), p.id)
  }, [reject])

  const merge = useCallback(async (fromId: string, intoId: string) => {
    if (fromId === intoId) return
    const ids = facesRef.current.filter((f) => f.personId === fromId || f.rejected.includes(fromId)).map((f) => f.id)
    await setPeople(peopleRef.current.filter((p) => p.id !== fromId))
    await updateFaces(ids, (f) => ({
      ...f,
      personId: f.personId === fromId ? intoId : f.personId,
      rejected: [...new Set(f.rejected.map((r) => (r === fromId ? intoId : r)))],
    }))
  }, [updateFaces])

  const rename = useCallback(async (personId: string, name: string) => {
    const n = name.trim().replace(/\s+/g, ' ')
    if (!n) return
    const other = personByName(n)
    if (other && other.id !== personId) { await merge(personId, other.id); return }
    await setPeople(peopleRef.current.map((p) => (p.id === personId ? { ...p, name: n } : p)))
    await syncTags(facesRef.current.filter((f) => f.personId === personId).map((f) => f.photoId).concat(
      libRef.current.photos.filter((p) => p.tags.some((t) => t.source === 'person')).map((p) => p.id)))
  }, [merge, syncTags])

  const deletePerson = useCallback(async (personId: string) => {
    const ids = facesRef.current.filter((f) => f.personId === personId || f.rejected.includes(personId)).map((f) => f.id)
    await setPeople(peopleRef.current.filter((p) => p.id !== personId))
    await updateFaces(ids, (f) => ({
      ...f, status: f.personId === personId ? 'unknown' : f.status, personId: f.personId === personId ? undefined : f.personId,
      rejected: f.rejected.filter((r) => r !== personId),
    }))
  }, [updateFaces])

  const clearFaceData = useCallback(async () => {
    const photoIds = [...new Set(facesRef.current.map((f) => f.photoId))]
    await DB.clearFaces()
    setFaces([])
    await setPeople([])
    for (const u of urls.values()) URL.revokeObjectURL(u)
    urls.clear()
    await libRef.current.updatePhotos(libRef.current.photos.map((p) => p.id), (p) => ({
      ...p, facesScanned: false, faceCount: undefined, tags: p.tags.filter((t) => t.source !== 'person'),
    }))
    void photoIds
    libRef.current.toast('All face data deleted from this device', 'ok')
  }, [])

  const setEnabled = useCallback(async (on: boolean) => {
    await libRef.current.saveSettings({ faceEnabled: on })
  }, [])

  const faceUrl = useCallback((f: Face) => {
    let u = urls.get(f.id)
    if (!u) { u = URL.createObjectURL(f.thumb); urls.set(f.id, u) }
    return u
  }, [])

  const clusters = useMemo(
    () => clusterFaces(faces.filter((f) => f.status === 'unknown' && !suggestions.has(f.id)), CLUSTER_THRESHOLD),
    [faces, suggestions],
  )
  const personTagNames = useMemo(() => new Set(people.map((p) => normTag(p.name))), [people])

  const value: People = {
    ready, faces, people, suggestions, clusters, scan,
    unscanned: lib.photos.filter((p) => !p.facesScanned && p.status !== 'error').length,
    faceUrl, scanLibrary, nameFaces, confirm, reject, ignore, rejectOnPhotos, rename, merge, deletePerson, setEnabled, clearFaceData,
    isPersonTag: (n) => personTagNames.has(n),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
