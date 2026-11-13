/** 'dropbox' = imported from the file's native Dropbox tags (not created by Photo Tagger) */
export type TagSource = 'auto' | 'manual' | 'exif' | 'quality' | 'person' | 'dropbox'

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
  /** Dropbox-backed photo (v1.0.7+): lives in Dropbox; tags/faces are stored in /.photo-tagger sidecars in Dropbox, nothing locally */
  dropbox?: DropboxRef
  /** native Dropbox file tags Photo Tagger itself added (so only these are ever removed) */
  dropboxTags?: string[]
  /** Dropbox tags removed on the Dropbox side; never written back until the tag is added again */
  dropboxRemoved?: string[]
  /** 1.0.34: Dropbox tags you deleted/renamed in Photo Tagger that are still on the file — removed from Dropbox on the next save (only your own edits ever remove a Dropbox tag that was there before) */
  dropboxDelete?: string[]
  hasOriginal: boolean
  /** desktop: relative path of the original inside the library folder */
  relPath?: string
  status: PhotoStatus
  error?: string
  /** face detection has run on this photo */
  facesScanned?: boolean
  faceCount?: number
}

export interface DropboxRef {
  /** stable Dropbox file id ("id:…") */
  id: string
  path: string
  rev?: string
  contentHash?: string
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
  /** photo-metadata tags switched off on the Detection list (year, camera, geotagged, blurry, dark, bright) */
  disabledMetaTags: string[]
  faceEnabled: boolean
  /** max face-descriptor distance for a suggested match (lower = stricter) */
  faceThreshold: number
  /** max dHash Hamming distance (0–64) to treat two photos as near-duplicates */
  dupeThreshold: number
  /** Dropbox imports larger than this are tagged, saved and verified in batches (1.0.27) */
  dropboxBatchSize: number
  /** show "Check your detection list first" before a Dropbox import into an empty library (1.0.27) */
  askBeforeFirstImport: boolean
  /** order for "Add next …" in the Dropbox browser (1.0.30) */
  dropboxAddOrder: 'name' | 'oldest' | 'newest'
  /** "How many to add" in the Dropbox browser (1.0.32); unset = use Photos per batch */
  dropboxAddCount?: number
  /** the count was typed as a custom number (keeps "Custom…" selected even for 25/50/…) */
  dropboxAddCountCustom?: boolean
  /** what the Detection list looked like before "Turn all off" (1.0.32), for "Restore previous" */
  autoTagsBackup?: { disabledLabels: string[]; disabledMetaTags: string[] }
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
  disabledMetaTags: [],
  faceEnabled: true,
  faceThreshold: 0.5,
  dupeThreshold: 8,
  dropboxBatchSize: 100,
  askBeforeFirstImport: true,
  dropboxAddOrder: 'name',
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
