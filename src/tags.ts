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

export function exifAndQualityTags(p: Pick<Photo, 'takenAt' | 'dateSource' | 'camera' | 'gps' | 'quality'>): Tag[] {
  const out: Tag[] = []
  if (p.takenAt && p.dateSource === 'exif') out.push({ name: String(new Date(p.takenAt).getFullYear()), source: 'exif' })
  if (p.camera) out.push({ name: normTag(p.camera), source: 'exif' })
  if (p.gps) out.push({ name: 'geotagged', source: 'exif' })
  if (p.quality.blurry) out.push({ name: 'blurry', source: 'quality' })
  if (p.quality.dark) out.push({ name: 'dark', source: 'quality' })
  if (p.quality.bright) out.push({ name: 'bright', source: 'quality' })
  return out
}
