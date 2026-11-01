import exifr from 'exifr'
import type { Quality, Settings } from './types'

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    // Fallback via <img> (older Safari)
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return await createImageBitmap(img)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

export function scaledCanvas(bmp: ImageBitmap, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(bmp.width * scale))
  c.height = Math.max(1, Math.round(bmp.height * scale))
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, c.width, c.height)
  return c
}

export const toBlob = (c: HTMLCanvasElement, q = 0.82) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', q))

/** Variance of the Laplacian (blur, exposure-normalised) and mean luma on a 256 px greyscale copy. */
export function analyseQuality(bmp: ImageBitmap, s: Pick<Settings, 'blurThreshold' | 'darkThreshold' | 'brightThreshold'>): Quality {
  const long = Math.max(bmp.width, bmp.height)
  const c = scaledCanvas(bmp, Math.min(1, 256 / long))
  const { width: w, height: h } = c
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data
  const g = new Float32Array(w * h)
  let sum = 0
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    const y = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]
    g[i] = y
    sum += y
  }
  const brightness = sum / g.length
  // Normalise for exposure so a dark (low-contrast) but sharp photo is not mistaken for a blurry one.
  const k = 128 / Math.max(brightness, 10)
  for (let i = 0; i < g.length; i++) g[i] *= k
  let n = 0, m = 0, m2 = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const l = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i]
      n++; m += l; m2 += l * l
    }
  }
  const sharpness = n ? m2 / n - (m / n) ** 2 : 0
  return qualityFlags(sharpness, brightness, s)
}

export function qualityFlags(sharpness: number, brightness: number, s: Pick<Settings, 'blurThreshold' | 'darkThreshold' | 'brightThreshold'>): Quality {
  return {
    sharpness: Math.round(sharpness * 10) / 10,
    brightness: Math.round(brightness * 10) / 10,
    blurry: sharpness < s.blurThreshold,
    dark: brightness < s.darkThreshold,
    bright: brightness > s.brightThreshold,
  }
}

/** RGB pixels with the short side at 224 px, for CLIP. */
export function clipPixels(bmp: ImageBitmap): { rgb: Uint8ClampedArray; width: number; height: number } {
  const short = Math.min(bmp.width, bmp.height)
  const scale = 224 / short
  const c = scaledCanvas(bmp, scale)
  const rgba = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data
  const rgb = new Uint8ClampedArray(c.width * c.height * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]
  }
  return { rgb, width: c.width, height: c.height }
}

export interface ExifInfo { takenAt?: number; camera?: string; gps?: { lat: number; lon: number } }

export async function readExif(file: Blob): Promise<ExifInfo> {
  try {
    const x: any = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'latitude', 'longitude'], gps: true, tiff: true, exif: true,
    })
    if (!x) return {}
    const d: Date | undefined = x.DateTimeOriginal ?? x.CreateDate
    const t = d instanceof Date && !isNaN(+d) ? +d : undefined
    let camera: string | undefined
    if (x.Model) {
      const model = String(x.Model).trim()
      const make = String(x.Make ?? '').trim()
      camera = make && !model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? `${make} ${model}` : model
    }
    const gps = typeof x.latitude === 'number' && typeof x.longitude === 'number' ? { lat: x.latitude, lon: x.longitude } : undefined
    return { takenAt: t, camera, gps }
  } catch {
    return {}
  }
}
