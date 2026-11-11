import type { Photo, Tag, TagSource } from './types'

/** Stored tag form: lowercase, single spaces, at most 40 chars, never starting/ending with a space (1.0.28: cut, then trim). */
export const normTag = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40).trim()
/** the pre-1.0.28 normTag (cut after trimming, so it could end in a space) — only for recognising legacy data */
const legacyNormTag = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40)

// ---------- camera tag (1.0.28): short, readable, fits a 32-char Dropbox tag ----------
/** long EXIF makes → the brand people know */
const MAKE_BRANDS: [RegExp, string][] = [
  [/\beastman kodak( company)?\b/g, 'kodak'], [/\bnikon corporation\b/g, 'nikon'], [/\bolympus (imaging|optical)( corp\.?| co\.?,? ltd\.?)?/g, 'olympus'],
  [/\bsamsung electronics( co\.?,? ltd\.?)?/g, 'samsung'], [/\bpentax corporation\b/g, 'pentax'], [/\bricoh imaging company,? ltd\.?/g, 'ricoh'],
  [/\bhewlett[- ]packard( company)?\b/g, 'hp'], [/\bresearch in motion\b/g, 'blackberry'], [/\bminolta co\.?,? ltd\.?/g, 'minolta'],
  [/\bseiko epson corp\.?/g, 'epson'], [/\bcasio computer co\.?,? ?ltd\.?/g, 'casio'], [/\bfujifilm corporation\b/g, 'fujifilm'], [/\bfuji photo film co\.?,? ?ltd\.?/g, 'fujifilm'],
  [/\bsony ericsson mobile communications( ab)?\b/g, 'sony ericsson'], [/\bmotorola mobility( llc)?\b/g, 'motorola'], [/\blg electronics( inc\.?)?/g, 'lg'],
]
const CAMERA_FILLER = /\b(zoom digital camera|digital still camera|digital camera|camera|company|corporation|corp\.?|co\.?|ltd\.?|inc\.?|imaging|optical|electronics)(?=\s|$|,)/g
/**
 * The camera tag for an EXIF make + model ("EASTMAN KODAK COMPANY KODAK CX7530 ZOOM DIGITAL CAMERA" → "kodak cx7530").
 * Brand names are shortened, corporate suffixes and "digital camera" filler dropped, a repeated brand removed, and the
 * result kept to 32 characters (cut at a word boundary) so the Dropbox tag is never truncated. The Camera field keeps the full name.
 */
export function cameraTag(camera: string): string {
  let s = ` ${camera.toLowerCase().replace(/\s+/g, ' ').trim()} `
  for (const [re, b] of MAKE_BRANDS) s = s.replace(re, b)
  s = s.replace(CAMERA_FILLER, ' ').replace(/[,]+/g, ' ').replace(/\s+/g, ' ').trim()
  const words = s.split(' ').filter(Boolean)
  const out: string[] = []
  for (const w of words) if (!(out.length && w === out[0] && out.length <= 2) && w !== out[out.length - 1]) out.push(w)
  let t = out.join(' ')
  if (!t) t = normTag(camera)
  while (t.length > 32 && t.includes(' ')) t = t.slice(0, t.lastIndexOf(' '))
  return normTag(t.slice(0, 32))
}

const SOURCE_RANK: Record<TagSource, number> = { person: 0, manual: 1, dropbox: 2, auto: 3, exif: 4, quality: 4 }
/**
 * Load-time repair (1.0.28): tag names re-normalized (no stray spaces), duplicates merged keeping the stronger source
 * (person > manual > dropbox > auto > exif/quality), and the old long camera tag (exif only) replaced by cameraTag().
 * Returns the same object when nothing changed.
 */
export function repairPhotoTags<T extends Pick<Photo, 'tags' | 'rejected' | 'camera'> & { dropboxRemoved?: string[] }>(p: T): T {
  const oldCam = p.camera ? normTag(legacyNormTag(p.camera)) : ''
  const newCam = p.camera ? cameraTag(p.camera) : ''
  const merged = new Map<string, Tag>()
  for (const t of p.tags) {
    let name = normTag(t.name)
    if (t.source === 'exif' && oldCam && name === oldCam) name = newCam
    if (!name) continue
    const prev = merged.get(name)
    if (!prev) { merged.set(name, { ...t, name }); continue }
    const best = SOURCE_RANK[t.source] < SOURCE_RANK[prev.source] ? t : prev
    const score = Math.max(prev.score ?? -1, t.score ?? -1)
    merged.set(name, { ...best, name, ...(score >= 0 ? { score } : {}) })
  }
  const tags = [...merged.values()]
  const rejected = [...new Set(p.rejected.map(normTag).filter(Boolean))]
  let dropboxRemoved = p.dropboxRemoved
  // a camera tag removed in Dropbox stays removed under its new name too
  if (oldCam && newCam !== oldCam && dropboxRemoved?.length) {
    const was = oldCam.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32).replace(/_$/, '')
    const now = newCam.replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32).replace(/_$/, '')
    if (dropboxRemoved.includes(was) && !dropboxRemoved.includes(now)) dropboxRemoved = [...dropboxRemoved, now].sort()
  }
  const same = tags.length === p.tags.length && tags.every((t, i) => t.name === p.tags[i].name && t.source === p.tags[i].source && t.score === p.tags[i].score)
    && rejected.length === p.rejected.length && rejected.every((r, i) => r === p.rejected[i]) && dropboxRemoved === p.dropboxRemoved
  return same ? p : { ...p, tags, rejected, ...(dropboxRemoved ? { dropboxRemoved } : {}) }
}

export function addTag(p: Photo, name: string, source: TagSource, score?: number): Photo {
  const n = normTag(name)
  if (!n) return p
  const i = p.tags.findIndex((t) => t.name === n)
  if (i >= 0) {
    // a manual tag always wins over an automatic one
    if (source === 'manual' && p.tags[i].source !== 'manual') {
      const tags = p.tags.slice()
      tags[i] = { name: n, source: 'manual' }
      return { ...p, tags, rejected: p.rejected.filter((r) => r !== n) }
    }
    return p
  }
  return { ...p, tags: [...p.tags, { name: n, source, score }], rejected: p.rejected.filter((r) => r !== n) }
}

/** Remove a tag by exact name, or any stored variant that only differs by case/spaces (so ✕ always works). */
export function removeTag(p: Photo, name: string): Photo {
  const n = normTag(name)
  const hit = (x: Tag) => x.name === name || normTag(x.name) === n
  const t = p.tags.find(hit)
  if (!t) return p
  const rej = normTag(t.name)
  return {
    ...p,
    tags: p.tags.filter((x) => !hit(x)),
    rejected: t.source === 'auto' && !p.rejected.includes(rej) ? [...p.rejected, rej] : p.rejected,
  }
}

export const tagNames = (p: Photo) => p.tags.map((t) => t.name)

/** Photo-metadata tags that can be switched off on the Detection list (1.0.23). */
export const META_TAGS = [
  { id: 'year', label: 'Year' }, { id: 'camera', label: 'Camera' }, { id: 'geotagged', label: 'Geotagged' },
  { id: 'blurry', label: 'Blurry' }, { id: 'dark', label: 'Dark' }, { id: 'bright', label: 'Bright' },
] as const

export function exifAndQualityTags(p: Pick<Photo, 'takenAt' | 'dateSource' | 'camera' | 'gps' | 'quality'>, disabled: readonly string[] = []): Tag[] {
  const all = rawMetaTags(p)
  return all.filter((x) => !disabled.includes(x.key)).map(({ name, source }) => ({ name, source }))
}

/** Replace a photo's exif/quality tags with what the current toggles allow; other tags are untouched. */
export function applyMetaTags<T extends Pick<Photo, 'takenAt' | 'dateSource' | 'camera' | 'gps' | 'quality' | 'tags'>>(p: T, disabled: readonly string[] = []): T {
  const keep = p.tags.filter((t) => t.source !== 'exif' && t.source !== 'quality')
  const names = new Set(keep.map((t) => t.name))
  return { ...p, tags: [...keep, ...exifAndQualityTags(p, disabled).filter((t) => !names.has(t.name))] }
}

function rawMetaTags(p: Pick<Photo, 'takenAt' | 'dateSource' | 'camera' | 'gps' | 'quality'>): (Tag & { key: string })[] {
  const out: (Tag & { key: string })[] = []
  const push = (key: string, name: string, source: Tag['source']) => out.push({ key, name, source })
  if (p.takenAt && p.dateSource === 'exif') push('year', String(new Date(p.takenAt).getFullYear()), 'exif')
  if (p.camera) push('camera', cameraTag(p.camera), 'exif')
  if (p.gps) push('geotagged', 'geotagged', 'exif')
  if (p.quality.blurry) push('blurry', 'blurry', 'quality')
  if (p.quality.dark) push('dark', 'dark', 'quality')
  if (p.quality.bright) push('bright', 'bright', 'quality')
  return out
}


/** Loose key for "same topic" matching: case-insensitive; spaces, underscores and hyphens are equivalent. */
export const looseTagKey = (s: string) => normTag(s).replace(/[\s_-]+/g, '_').replace(/^_+|_+$/g, '')

/**
 * The tag name to store for what the user typed: an exact match wins, else an existing tag that only differs
 * by case/spaces/underscores/hyphens ("family trip" → existing "family_trip"), else the typed text itself.
 */
export function resolveTagName(typed: string, existing: readonly string[]): string {
  const n = normTag(typed)
  if (!n) return n
  if (existing.includes(n)) return n
  const k = looseTagKey(n)
  return existing.find((e) => looseTagKey(e) === k) ?? n
}

/** Suggestions matching what's typed (loose, substring); prefix matches first, then A–Z. Capped after filtering. */
export function matchTags(typed: string, all: readonly string[], cap = 200): string[] {
  const k = looseTagKey(typed)
  if (!k) return all.slice(0, cap)
  const hits = all.filter((t) => looseTagKey(t).includes(k))
  hits.sort((a, b) => Number(!looseTagKey(a).startsWith(k)) - Number(!looseTagKey(b).startsWith(k)) || a.localeCompare(b))
  return hits.slice(0, cap)
}
