export type TagSource = 'auto' | 'manual' | 'exif' | 'quality' | 'person'

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
  /** cheap fingerprint: name|size|lastModified (first-pass skip) */
  fp: string
  /** SHA-256 of the original file bytes (exact byte-identical copies) */
  contentHash?: string
  /** 64-bit dHash hex (near-duplicate / perceptual) */
  phash?: string
  /** id of the photo this is marked as a duplicate of */
  duplicateOf?: string
  /** photo ids the user said are NOT duplicates of this one */
  ignoredDupes?: string[]
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
  /** face detection has run on this photo */
  facesScanned?: boolean
  faceCount?: number
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
  faceEnabled: boolean
  /** max face-descriptor distance for a suggested match (lower = stricter) */
  faceThreshold: number
  /** max dHash Hamming distance (0–64) to treat two photos as near-duplicates */
  dupeThreshold: number
  /** when a save-folder is remembered and permission is still granted, write each newly tagged photo there */
  autoSaveFolder: boolean
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
  faceEnabled: true,
  faceThreshold: 0.5,
  dupeThreshold: 8,
  autoSaveFolder: false,
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

export interface Face {
  id: string
  photoId: string
  /** box as fractions of the photo's width/height */
  box: { x: number; y: number; w: number; h: number }
  score: number
  descriptor: Float32Array
  thumb: Blob
  status: 'unknown' | 'confirmed' | 'ignored'
  personId?: string
  /** people this face was rejected for – never suggested again */
  rejected: string[]
}

export interface Person {
  id: string
  name: string
  createdAt: number
}
