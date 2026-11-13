import { normTag } from './tags'

/**
 * 1.0.35 remembered tags: every tag ever used in Photo Tagger (on photos — including photos later removed from the
 * app — named People and your own list entries), so the Add a tag box and Settings → Tags keep offering them.
 *
 * Stored as two name → time maps so copies from different devices merge cleanly (newest wins per tag):
 * - `tags`: when the tag was last added on purpose. Tags only *seen* (on loaded photos, People, detection list)
 *   are recorded with time SEEN (1), so they never undo a removal made anywhere else.
 * - `forgotten`: when you removed it from the list (or renamed it away).
 * A tag is on the list while tags[n] > forgotten[n].
 */
export interface TagMemory { v: 1; tags: Record<string, number>; forgotten: Record<string, number> }

export const SEEN = 1
export const emptyTagMemory = (): TagMemory => ({ v: 1, tags: {}, forgotten: {} })

const isMap = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
/** Read a saved/remote value safely (anything unexpected → empty); names are re-normalised. */
export function cleanTagMemory(x: unknown): TagMemory {
  const out = emptyTagMemory()
  if (!isMap(x)) return out
  for (const key of ['tags', 'forgotten'] as const) {
    const src = x[key]
    if (!isMap(src)) continue
    for (const [k, v] of Object.entries(src)) {
      const n = normTag(k), t = Number(v)
      if (n && Number.isFinite(t) && t > 0) out[key][n] = Math.max(out[key][n] ?? 0, t)
    }
  }
  return out
}

export const isRemembered = (m: TagMemory, name: string) => (m.tags[name] ?? 0) > (m.forgotten[name] ?? 0)

/** The remembered tags, A–Z. */
export function rememberedTags(m: TagMemory): string[] {
  return Object.keys(m.tags).filter((n) => isRemembered(m, n)).sort((a, b) => a.localeCompare(b))
}

/**
 * Add names. `explicit` (you typed/picked it on a photo, renamed to it, or added it to the list) puts a removed tag back;
 * otherwise (seen on photos / People / detection list) a tag you removed from the list stays removed.
 * Returns the same object when nothing changed.
 */
export function rememberTags(m: TagMemory, names: Iterable<string>, explicit = false, now = Date.now()): TagMemory {
  let next: TagMemory | null = null
  for (const raw of names) {
    const n = normTag(String(raw ?? ''))
    if (!n) continue
    const cur = (next ?? m)
    if (explicit) {
      if (isRemembered(cur, n) && cur.tags[n] > SEEN) continue
      const t = Math.max(now, (cur.forgotten[n] ?? 0) + 1, (cur.tags[n] ?? 0))
      next ??= { v: 1, tags: { ...m.tags }, forgotten: { ...m.forgotten } }
      next.tags[n] = t
    } else {
      if (n in cur.tags || n in cur.forgotten) continue
      next ??= { v: 1, tags: { ...m.tags }, forgotten: { ...m.forgotten } }
      next.tags[n] = SEEN
    }
  }
  return next ?? m
}

/** Remove names from the list (suggestions only — photos are not changed). */
export function forgetTags(m: TagMemory, names: Iterable<string>, now = Date.now()): TagMemory {
  let next: TagMemory | null = null
  for (const raw of names) {
    const n = normTag(String(raw ?? ''))
    if (!n || !isRemembered(next ?? m, n)) continue
    next ??= { v: 1, tags: { ...m.tags }, forgotten: { ...m.forgotten } }
    next.forgotten[n] = Math.max(now, (next.tags[n] ?? 0) + 1)
  }
  return next ?? m
}

/** Rename (or merge into an existing tag): `from` leaves the list, `to` is on it. */
export function renameRememberedTag(m: TagMemory, from: string, to: string, now = Date.now()): TagMemory {
  const f = normTag(from), t = normTag(to)
  if (!f || !t || f === t) return t ? rememberTags(m, [t], true, now) : m
  return rememberTags(forgetTags(m, [f], now), [t], true, now)
}

/** Merge two copies (this device + Dropbox / another device): newest time wins per tag. Same object back when `a` already has everything. */
export function mergeTagMemory(a: TagMemory, b: TagMemory): TagMemory {
  let next: TagMemory | null = null
  for (const key of ['tags', 'forgotten'] as const) {
    for (const [n, t] of Object.entries(b[key])) {
      if ((a[key][n] ?? 0) >= t) continue
      next ??= { v: 1, tags: { ...a.tags }, forgotten: { ...a.forgotten } }
      next[key][n] = t
    }
  }
  return next ?? a
}

export const sameTagMemory = (a: TagMemory, b: TagMemory) => mergeTagMemory(a, b) === a && mergeTagMemory(b, a) === b
