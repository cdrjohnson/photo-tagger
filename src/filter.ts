import type { Filters, Photo, TagSource } from './types'

export const photoTime = (p: Photo) => p.takenAt ?? p.addedAt

function dayStart(s: string) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime() }
function dayEnd(s: string) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).getTime() }

export const isGood = (p: Photo) => !p.quality.blurry && !p.quality.dark && !p.quality.bright

/** Everything except the tag selection – used for the faceted tag counts. */
export function matchesBase(p: Photo, f: Filters): boolean {
  if (f.query.trim()) {
    const hay = [p.name, p.camera ?? '', ...p.tags.map((t) => t.name)].join(' ').toLowerCase()
    for (const term of f.query.toLowerCase().split(/\s+/).filter(Boolean)) if (!hay.includes(term)) return false
  }
  const t = photoTime(p)
  if (f.from && t < dayStart(f.from)) return false
  if (f.to && t > dayEnd(f.to)) return false
  switch (f.quality) {
    case 'good': if (!isGood(p)) return false; break
    case 'blurry': if (!p.quality.blurry) return false; break
    case 'dark': if (!p.quality.dark) return false; break
    case 'bright': if (!p.quality.bright) return false; break
  }
  return true
}

export function matchesTags(p: Photo, f: Filters): boolean {
  if (!f.tags.length) return true
  const names = new Set(p.tags.map((t) => t.name))
  return f.mode === 'and' ? f.tags.every((t) => names.has(t)) : f.tags.some((t) => names.has(t))
}

export function filterPhotos(photos: Photo[], f: Filters): Photo[] {
  const out = photos.filter((p) => matchesBase(p, f) && matchesTags(p, f))
  const cmp: Record<Filters['sort'], (a: Photo, b: Photo) => number> = {
    'taken-desc': (a, b) => photoTime(b) - photoTime(a),
    'taken-asc': (a, b) => photoTime(a) - photoTime(b),
    'added-desc': (a, b) => b.addedAt - a.addedAt,
    'name-asc': (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
  }
  return out.sort(cmp[f.sort])
}

export interface TagStat { name: string; count: number; source: TagSource }

const PRIORITY: TagSource[] = ['person', 'manual', 'auto', 'exif', 'quality']

/** Tag counts among the photos that match the non-tag filters; selected tags are always listed. */
export function tagStats(photos: Photo[], f: Filters): TagStat[] {
  const m = new Map<string, { count: number; src: Set<TagSource> }>()
  for (const p of photos) {
    if (!matchesBase(p, f)) continue
    for (const t of p.tags) {
      const e = m.get(t.name) ?? { count: 0, src: new Set<TagSource>() }
      e.count++; e.src.add(t.source); m.set(t.name, e)
    }
  }
  for (const s of f.tags) if (!m.has(s)) m.set(s, { count: 0, src: new Set(['manual']) })
  return [...m.entries()]
    .map(([name, e]) => ({ name, count: e.count, source: PRIORITY.find((s) => e.src.has(s))! }))
    // people first, then by count
    .sort((a, b) => Number(b.source === 'person') - Number(a.source === 'person') || b.count - a.count || a.name.localeCompare(b.name))
}
