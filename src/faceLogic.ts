import type { Face, Person } from './types'

export function faceDistance(a: Float32Array, b: Float32Array) {
  let s = 0
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d }
  return Math.sqrt(s)
}

export interface Suggestion { face: Face; personId: string; distance: number }

/**
 * For every unknown face, the closest named person (nearest confirmed example), if within `threshold`
 * and not previously rejected for that person.
 */
export function suggestMatches(faces: Face[], people: Person[], threshold: number): Map<string, Suggestion> {
  const examples = new Map<string, Face[]>()
  for (const f of faces) if (f.status === 'confirmed' && f.personId) examples.set(f.personId, [...(examples.get(f.personId) ?? []), f])
  const out = new Map<string, Suggestion>()
  const ids = new Set(people.map((p) => p.id))
  for (const f of faces) {
    if (f.status !== 'unknown') continue
    let best: Suggestion | null = null
    for (const [pid, ex] of examples) {
      if (!ids.has(pid) || f.rejected.includes(pid)) continue
      // never suggest a person for a second face in a photo where they are already confirmed
      if (ex.some((e) => e.photoId === f.photoId)) continue
      for (const e of ex) {
        const d = faceDistance(f.descriptor, e.descriptor)
        if (d <= threshold && (!best || d < best.distance)) best = { face: f, personId: pid, distance: d }
      }
    }
    if (best) out.set(f.id, best)
  }
  return out
}

/** Leader clustering of unnamed faces: a face joins the first cluster whose centroid is within `threshold`. */
export function clusterFaces(faces: Face[], threshold: number): Face[][] {
  const clusters: { members: Face[]; sum: Float32Array }[] = []
  const sorted = faces.slice().sort((a, b) => b.score - a.score)
  for (const f of sorted) {
    let best = -1, bestD = Infinity
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i]
      const centroid = c.sum.map((v) => v / c.members.length)
      const d = faceDistance(f.descriptor, centroid)
      if (d < bestD) { bestD = d; best = i }
    }
    if (best >= 0 && bestD <= threshold) {
      const c = clusters[best]
      c.members.push(f)
      for (let i = 0; i < c.sum.length; i++) c.sum[i] += f.descriptor[i]
    } else clusters.push({ members: [f], sum: Float32Array.from(f.descriptor) })
  }
  return clusters.map((c) => c.members).sort((a, b) => b.length - a.length)
}
