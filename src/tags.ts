import type { Photo, Tag, TagSource } from './types'

export const normTag = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40)

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

export function removeTag(p: Photo, name: string): Photo {
  const t = p.tags.find((x) => x.name === name)
  if (!t) return p
  return {
    ...p,
    tags: p.tags.filter((x) => x.name !== name),
    rejected: t.source === 'auto' && !p.rejected.includes(name) ? [...p.rejected, name] : p.rejected,
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
  if (p.camera) push('camera', normTag(p.camera), 'exif')
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
