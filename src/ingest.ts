import { analyseQuality, clipPixels, decodeImage, readExif, scaledCanvas, toBlob } from './imageUtils'
import { contentHash, dHashFromBitmap } from './hashes'
import { exifAndQualityTags } from './tags'
import type { Photo, Settings } from './types'
import { isDesktop } from './platform'

export const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i
export const isImageFile = (f: File) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name)

export const fingerprint = (f: { name: string; size: number; lastModified?: number }) =>
  `${f.name}|${f.size}|${f.lastModified ?? 0}`

const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

export interface Prepared {
  photo: Photo
  blobs: { thumb: Blob; view: Blob; original?: Blob }
  rgb: Uint8ClampedArray
  rw: number
  rh: number
  /** raw file bytes hash (computed while reading) */
  contentHash: string
}

/** Decode, thumbnail, read EXIF, run quality checks, compute content + perceptual hashes. Does not run the ML model. */
export async function prepare(file: File, source: Photo['source'], settings: Settings): Promise<Prepared> {
  const [exif, bmp, bytes] = await Promise.all([readExif(file), decodeImage(file), file.arrayBuffer()])
  try {
    const ch = await contentHash(bytes)
    const ph = dHashFromBitmap(bmp)
    const long = Math.max(bmp.width, bmp.height)
    const thumb = await toBlob(scaledCanvas(bmp, Math.min(1, 360 / long)), 0.8)
    const small = long <= 2048 && file.size < 2_500_000 && /image\/(jpeg|png|webp)/.test(file.type)
    const view = small ? file : await toBlob(scaledCanvas(bmp, Math.min(1, 2048 / long)), 0.86)
    const quality = analyseQuality(bmp, settings)
    const { rgb, width: rw, height: rh } = clipPixels(bmp)
    const now = Date.now()
    const lm = file.lastModified && file.lastModified > 0 ? file.lastModified : undefined
    const desktop = isDesktop()
    const keepOrig = desktop || settings.keepOriginals || small
    const base: Photo = {
      id: uid(),
      fp: fingerprint({ name: file.name, size: file.size, lastModified: source === 'device' ? file.lastModified : 0 }),
      contentHash: ch,
      phash: ph,
      name: file.name,
      size: file.size,
      type: file.type || 'image/jpeg',
      addedAt: now,
      takenAt: exif.takenAt ?? lm ?? now,
      dateSource: exif.takenAt ? 'exif' : lm ? 'file' : 'added',
      width: bmp.width,
      height: bmp.height,
      camera: exif.camera,
      gps: exif.gps,
      quality,
      tags: [],
      rejected: [],
      source,
      hasOriginal: keepOrig,
      status: 'pending',
    }
    base.tags = exifAndQualityTags(base)
    return {
      photo: base,
      // Desktop always writes the original file into the library folder
      blobs: { thumb, view, original: desktop || settings.keepOriginals || small ? file : undefined },
      rgb, rw, rh,
      contentHash: ch,
    }
  } finally {
    bmp.close()
  }
}

/** CLIP pixels from an already-stored blob (used to retry photos whose tagging was interrupted). */
export async function pixelsFromBlob(blob: Blob) {
  const bmp = await decodeImage(blob)
  try { return clipPixels(bmp) } finally { bmp.close() }
}

/** Recompute contentHash + phash for a photo that is missing them (from its stored view / original). */
export async function hashesFromBlob(blob: Blob): Promise<{ contentHash: string; phash: string }> {
  const [bytes, bmp] = await Promise.all([blob.arrayBuffer(), decodeImage(blob)])
  try {
    return { contentHash: await contentHash(bytes), phash: dHashFromBitmap(bmp) }
  } finally {
    bmp.close()
  }
}
