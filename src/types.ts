export type TagSource = 'auto' | 'manual' | 'exif' | 'quality'

export interface Tag {
  name: string
  source: TagSource
  /** CLIP confidence (0..1) for auto tags */
  score?: number
}

export interface Quality {
  sharpness: number // variance of Laplacian on a 256 px greyscale copy (higher = sharper)
  brightness: number // mean luma 0..255
  blurry: boolean
  dark: boolean
  bright: boolean
}

export type PhotoStatus = 'pending' | 'ready' | 'error'

export interface Photo {
  id: string
  /** duplicate-detection fingerprint: name|size|lastModified */
  fp: string
  name: string
  size: number
  type: string
  addedAt: number
  takenAt?: number
  dateSource: 'exif' | 'file' | 'added'
  width: number
  height: number
  camera?: string
  gps?: { lat: number; lon: number }
  quality: Quality
  tags: Tag[]
  /** auto tags the user removed; re-tagging never brings them back */
  rejected: string[]
  source: 'device' | 'dropbox'
  hasOriginal: boolean
  status: PhotoStatus
  error?: string
}

export interface Settings {
  dropboxAppKey: string
  modelHost: string
  keepOriginals: boolean
  threshold: number // min softmax probability for an auto tag
  maxTags: number
  blurThreshold: number
  darkThreshold: number
  brightThreshold: number
  disabledLabels: string[]
}

export interface CustomLabel {
  id: string
  label: string
  prompt: string
  group: string
}

export const DEFAULT_SETTINGS: Settings = {
  dropboxAppKey: '',
  modelHost: 'https://huggingface.co/',
  keepOriginals: false,
  threshold: 0.12,
  maxTags: 4,
  blurThreshold: 60,
  darkThreshold: 55,
  brightThreshold: 200,
  disabledLabels: [],
}

export type FilterMode = 'and' | 'or'
export type QualityFilter = 'any' | 'good' | 'blurry' | 'dark' | 'bright'
export type SortKey = 'taken-desc' | 'taken-asc' | 'added-desc' | 'name-asc'

export interface Filters {
  tags: string[]
  mode: FilterMode
  query: string
  from: string
  to: string
  quality: QualityFilter
  sort: SortKey
}

export const EMPTY_FILTERS: Filters = {
  tags: [], mode: 'and', query: '', from: '', to: '', quality: 'any', sort: 'taken-desc',
}
