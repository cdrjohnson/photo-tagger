import { DEFAULT_LABELS, type LabelDef } from './labels'
import labelEmb from './ml/labelEmbeddings.json'
import type { CustomLabel, Photo, Settings, Tag } from './types'
import { normTag } from './tags'

export interface VocabEntry {
  id: string
  label: string
  emb: Float32Array
  implies: string[]
}

function b64ToF32(s: string): Float32Array {
  const bin = atob(s)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return new Float32Array(u8.buffer)
}

const builtinEmb: Record<string, Float32Array> = {}
for (const [k, v] of Object.entries((labelEmb as { labels: Record<string, string> }).labels)) builtinEmb[k] = b64ToF32(v)

export const builtinLabels = (): LabelDef[] => DEFAULT_LABELS

/** Build the active vocabulary from built-ins (minus disabled) and custom labels (embeddings from cache). */
export function buildVocab(settings: Settings, custom: CustomLabel[], customEmb: Map<string, Float32Array>): VocabEntry[] {
  const out: VocabEntry[] = []
  for (const l of DEFAULT_LABELS) {
    if (settings.disabledLabels.includes(l.id)) continue
    out.push({ id: l.id, label: l.label, emb: builtinEmb[l.id], implies: l.implies ?? [] })
  }
  for (const c of custom) {
    const e = customEmb.get(c.prompt)
    if (e && !settings.disabledLabels.includes(c.id)) out.push({ id: c.id, label: normTag(c.label), emb: e, implies: [] })
  }
  return out
}

export const LOGIT_SCALE = 100

/** Zero-shot scoring: softmax over cosine similarity (CLIP logit scale 100). */
export function scoreTags(imageEmb: Float32Array, vocab: VocabEntry[], threshold: number, maxTags: number): Tag[] {
  if (!vocab.length) return []
  const sims = vocab.map((v) => {
    let s = 0
    for (let i = 0; i < imageEmb.length; i++) s += imageEmb[i] * v.emb[i]
    return s
  })
  const mx = Math.max(...sims)
  const ex = sims.map((s) => Math.exp(LOGIT_SCALE * (s - mx)))
  const Z = ex.reduce((a, b) => a + b, 0)
  const ranked = vocab.map((v, i) => ({ v, p: ex[i] / Z, s: sims[i] })).sort((a, b) => b.p - a.p)
  const chosen = ranked.filter((r, i) => (i === 0 || r.p >= threshold) && r.s >= 0.18).slice(0, Math.max(1, maxTags))
  const tags: Tag[] = []
  const seen = new Set<string>()
  const push = (name: string, p: number) => {
    const n = normTag(name)
    if (!seen.has(n)) { seen.add(n); tags.push({ name: n, source: 'auto', score: Math.round(p * 1000) / 1000 }) }
  }
  for (const c of chosen) push(c.v.label, c.p)
  for (const c of chosen) for (const imp of c.v.implies) push(imp, c.p)
  return tags
}

/** Replace a photo's auto tags with a fresh scoring, keeping manual/exif/quality tags and honouring removals. */
export function applyAutoTags(p: Photo, auto: Tag[]): Photo {
  const kept = p.tags.filter((t) => t.source !== 'auto')
  const keptNames = new Set(kept.map((t) => t.name))
  const fresh = auto.filter((t) => !p.rejected.includes(t.name) && !keptNames.has(t.name))
  return { ...p, tags: [...kept, ...fresh], status: 'ready', error: undefined }
}
