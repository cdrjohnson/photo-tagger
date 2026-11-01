import type { CustomLabel, Photo, Settings, Tag } from './types'
import { normTag } from './tags'

export const APP_ID = 'photo-tagger'

export interface ExportedPhoto {
  name: string
  size: number
  takenAt?: string
  camera?: string
  latitude?: number
  longitude?: number
  source: string
  tags: Tag[]
  rejected?: string[]
}
export interface ExportFile {
  app: typeof APP_ID
  version: 1
  exportedAt: string
  vocabulary: { disabled: string[]; custom: CustomLabel[] }
  photos: ExportedPhoto[]
}

export function toJSON(photos: Photo[], settings: Settings, custom: CustomLabel[]): string {
  const data: ExportFile = {
    app: APP_ID, version: 1, exportedAt: new Date().toISOString(),
    vocabulary: { disabled: settings.disabledLabels, custom },
    photos: photos.map((p) => ({
      name: p.name, size: p.size,
      takenAt: p.takenAt ? new Date(p.takenAt).toISOString() : undefined,
      camera: p.camera, latitude: p.gps?.lat, longitude: p.gps?.lon, source: p.source,
      tags: p.tags, rejected: p.rejected.length ? p.rejected : undefined,
    })),
  }
  return JSON.stringify(data, null, 2)
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCSV(photos: Photo[]): string {
  const rows = [['name', 'size', 'taken', 'camera', 'latitude', 'longitude', 'source', 'tags']]
  for (const p of photos) {
    rows.push([
      p.name, String(p.size), p.takenAt ? new Date(p.takenAt).toISOString() : '', p.camera ?? '',
      p.gps ? String(p.gps.lat) : '', p.gps ? String(p.gps.lon) : '', p.source, p.tags.map((t) => t.name).join(';'),
    ])
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

export interface ImportEntry { name: string; size?: number; tags: Tag[]; rejected?: string[] }
export interface ImportResult {
  entries: ImportEntry[]
  vocabulary?: ExportFile['vocabulary']
}

export function parseImport(filename: string, text: string): ImportResult {
  const t = text.replace(/^\uFEFF/, '')
  if (filename.toLowerCase().endsWith('.json') || t.trimStart().startsWith('{')) {
    const j = JSON.parse(t) as ExportFile
    if (j.app !== APP_ID || !Array.isArray(j.photos)) throw new Error('This JSON file was not exported by Photo Tagger.')
    return {
      vocabulary: j.vocabulary,
      entries: j.photos.map((p) => ({
        name: p.name, size: p.size,
        tags: (p.tags ?? []).map((x) => ({ ...x, name: normTag(x.name) })).filter((x) => x.name),
        rejected: p.rejected,
      })),
    }
  }
  const rows = parseCSV(t)
  if (rows.length < 2) throw new Error('The CSV file is empty.')
  const head = rows[0].map((h) => h.trim().toLowerCase())
  const ni = head.indexOf('name'), ti = head.indexOf('tags'), si = head.indexOf('size')
  if (ni < 0 || ti < 0) throw new Error('The CSV needs "name" and "tags" columns (tags separated by ;).')
  return {
    entries: rows.slice(1).map((r) => ({
      name: r[ni],
      size: si >= 0 && r[si] ? Number(r[si]) : undefined,
      tags: (r[ti] ?? '').split(/[;|]/).map(normTag).filter(Boolean).map((name) => ({ name, source: 'manual' as const })),
    })),
  }
}

export function download(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
