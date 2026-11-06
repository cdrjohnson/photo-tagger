/** Content and perceptual hashes for duplicate detection. */

/** SHA-256 of the raw file bytes, hex. Identical files (renamed, re-exported copy of the same bytes) share this. */
export async function contentHash(buf: ArrayBuffer | ArrayBufferView): Promise<string> {
  const data = buf instanceof ArrayBuffer ? buf : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  const dig = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Difference hash (dHash): 9×8 greyscale → 64 bits from adjacent-pixel comparisons.
 * Hamming distance of 0 = visually identical at this resolution; ≤ ~8–10 covers recompress / slight resize.
 */
export function dHashFromBitmap(bmp: ImageBitmap | HTMLCanvasElement): string {
  const c = document.createElement('canvas')
  c.width = 9
  c.height = 8
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(bmp, 0, 0, 9, 8)
  const { data } = ctx.getImageData(0, 0, 9, 8)
  const g = new Float32Array(72)
  for (let i = 0, j = 0; i < 72; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]
  let bits = ''
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits += g[y * 9 + x] > g[y * 9 + x + 1] ? '1' : '0'
  }
  // pack to 16 hex chars
  let hex = ''
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

/** Hamming distance between two 16-char hex dHashes (0–64). */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    // popcount nibble
    x = x - ((x >>> 1) & 0x5)
    x = (x & 0x3) + ((x >>> 2) & 0x3)
    d += x
  }
  return d
}

/** Find the closest existing photo by phash within `threshold` (exclusive of self). */
export function nearestPhash(
  phash: string,
  photos: { id: string; phash?: string; ignoredDupes?: string[] }[],
  threshold: number,
  selfId?: string,
): { id: string; distance: number } | null {
  let best: { id: string; distance: number } | null = null
  for (const p of photos) {
    if (!p.phash || p.id === selfId) continue
    if (selfId && (p.ignoredDupes?.includes(selfId) || photos.find((x) => x.id === selfId)?.ignoredDupes?.includes(p.id))) continue
    const d = hamming(phash, p.phash)
    if (d <= threshold && (!best || d < best.distance)) best = { id: p.id, distance: d }
  }
  return best
}
