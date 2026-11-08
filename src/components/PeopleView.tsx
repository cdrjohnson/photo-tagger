import { useMemo, useState } from 'react'
import { usePeople } from '../people'
import { useLibrary } from '../store'
import type { Face, Person, Photo } from '../types'

export function PeopleView({ onShowPhotos }: { onShowPhotos: (tag: string) => void }) {
  const lib = useLibrary()
  const ppl = usePeople()
  const [open, setOpen] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const enabled = lib.settings.faceEnabled
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of ppl.faces) if (f.status === 'confirmed' && f.personId) m.set(f.personId, (m.get(f.personId) ?? 0) + 1)
    return m
  }, [ppl.faces])
  const sugByPerson = useMemo(() => {
    const m = new Map<string, Face[]>()
    for (const s of ppl.suggestions.values()) m.set(s.personId, [...(m.get(s.personId) ?? []), s.face])
    return m
  }, [ppl.suggestions])
  const avatar = (p: Person) => ppl.faces.find((f) => f.personId === p.id && f.status === 'confirmed')
  const people = ppl.people.slice().sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.name.localeCompare(b.name))
  // One picker list for every "who is this?" field: people first, then Dropbox tags, your tags, other detected tags
  const names = useMemo(() => nameOptions(ppl.people, lib.photos), [ppl.people, lib.photos])

  return (
    <div className="people" data-testid="people-view">
      <datalist id="people-names" data-testid="people-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
      <section className="note privacy" data-testid="privacy-note">
        <div>
          <b>🔒 Face recognition stays on this device.</b> Faces are found and compared by a small model running in your browser.
          Face crops, face "fingerprints" (128 numbers per face) and names are stored only in this browser and are never uploaded.
        </div>
        <div className="row wrap">
          <label className="check inline">
            <input type="checkbox" checked={enabled} data-testid="face-enabled" onChange={(e) => void ppl.setEnabled(e.target.checked)} />
            <span>Face recognition {enabled ? 'on' : 'off'}</span>
          </label>
          <button className={`btn small danger ${armed ? 'armed' : ''}`} data-testid="face-clear" onClick={async () => {
            if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 4000); return }
            setArmed(false); await ppl.clearFaceData()
          }}>{armed ? 'Click again to delete all face data' : 'Clear all face data'}</button>
        </div>
      </section>

      {enabled && ppl.unscanned > 0 && !ppl.scan && (
        <div className="note row wrap">
          <span className="grow">{ppl.unscanned} photo(s) haven’t been checked for faces yet.</span>
          <button className="btn primary small" data-testid="face-scan" onClick={() => void ppl.scanLibrary()}>Find faces</button>
        </div>
      )}
      {ppl.scan && (
        <div className="note bar-line" data-testid="face-scan-progress">
          <span>Looking for faces… {ppl.scan.done}/{ppl.scan.total} (first run downloads the ≈12 MB face model)</span>
          <div className="bar"><i style={{ width: `${(ppl.scan.done / ppl.scan.total) * 100}%` }} /></div>
        </div>
      )}

      <label className="field threshold">
        <span>Match strictness <b data-testid="face-threshold-value">{lib.settings.faceThreshold.toFixed(2)}</b></span>
        <input type="range" min={0.3} max={0.7} step={0.01} value={lib.settings.faceThreshold} data-testid="face-threshold"
          onChange={(e) => void lib.saveSettings({ faceThreshold: Number(e.target.value) })} />
        <small>How similar a face must be to suggest it as someone you’ve named. Left = stricter (fewer, safer suggestions); right = looser.</small>
      </label>

      <h2>People <small>{people.length}</small></h2>
      {!people.length && <p className="muted">Nobody named yet. Name a face below and Photo Tagger will suggest the same person in other photos.</p>}
      <div className="person-grid">
        {people.map((p) => {
          const a = avatar(p)
          const sug = sugByPerson.get(p.id)?.length ?? 0
          return (
            <button key={p.id} className={`person-card ${open === p.id ? 'on' : ''}`} data-testid="person-card" data-person={p.name} onClick={() => setOpen(open === p.id ? null : p.id)}>
              {a ? <img src={ppl.faceUrl(a)} alt="" /> : <div className="face ph" />}
              <b>{p.name}</b>
              <small>{counts.get(p.id) ?? 0} photo{(counts.get(p.id) ?? 0) === 1 ? '' : 's'}{sug ? ` · ${sug} to review` : ''}</small>
            </button>
          )
        })}
      </div>
      {open && ppl.people.find((p) => p.id === open) && (
        <PersonPanel person={ppl.people.find((p) => p.id === open)!} onClose={() => setOpen(null)} onShowPhotos={onShowPhotos} />
      )}

      {ppl.suggestions.size > 0 && (
        <>
          <h2>Is this…? <small data-testid="suggestion-count">{ppl.suggestions.size}</small></h2>
          {[...sugByPerson.entries()].map(([pid, fs]) => {
            const p = ppl.people.find((x) => x.id === pid)
            return p && <Suggestions key={pid} person={p} faces={fs} />
          })}
        </>
      )}

      <h2>Unnamed faces <small>{ppl.clusters.reduce((n, c) => n + c.length, 0)}</small></h2>
      {!ppl.faces.length && <p className="muted">{enabled ? 'No faces found yet. Add photos with people in them.' : 'Face recognition is off.'}</p>}
      <div className="clusters">
        {ppl.clusters.map((c) => <Cluster key={c[0].id} faces={c} names={names} />)}
      </div>
    </div>
  )
}

function FaceImg({ f, children, testId = 'face' }: { f: Face; children?: React.ReactNode; testId?: string }) {
  const ppl = usePeople()
  return (
    <div className="face" data-testid={testId} data-face={f.id} data-photo={f.photoId}>
      <img src={ppl.faceUrl(f)} alt="Face" loading="lazy" />
      {children}
    </div>
  )
}

/** Same name if it differs only by case, spaces or underscores ("beach house" = "beach_house"). */
export const nameKey = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, ' ')
export function nameOptions(people: Person[], photos: Photo[]): string[] {
  const seen = new Map<string, string>()
  const add = (n: string) => { const k = nameKey(n); if (k && !seen.has(k)) seen.set(k, n.trim()) }
  people.forEach((p) => add(p.name))
  const bySrc = (src: string) => [...new Set(photos.flatMap((p) => p.tags.filter((t) => t.source === src).map((t) => t.name)))].sort()
  for (const src of ['dropbox', 'manual', 'auto']) bySrc(src).forEach(add) // EXIF / quality tags aren't names
  return [...seen.values()]
}
/** Map a typed name onto an existing option with the same key so no second spelling is created. */
export const canonicalName = (typed: string, options: string[]) => options.find((o) => nameKey(o) === nameKey(typed)) ?? typed.trim()

function Cluster({ faces, names }: { faces: Face[]; names: string[] }) {
  const ppl = usePeople()
  const lib = useLibrary()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const photoName = (f: Face) => lib.photos.find((p) => p.id === f.photoId)?.name ?? ''
  const target = picked.size ? [...picked] : faces.map((f) => f.id)
  const submit = async () => { if (name.trim()) { await ppl.nameFaces(target, canonicalName(name, names)); setName(''); setPicked(new Set()) } }
  return (
    <div className="cluster" data-testid="cluster" data-photos={faces.map(photoName).join('|')}>
      <div className="faces">
        {faces.slice(0, 24).map((f) => (
          <FaceImg key={f.id} f={f}>
            <button className={`pick ${picked.has(f.id) ? 'on' : ''}`} aria-pressed={picked.has(f.id)} aria-label="Select this face" title={photoName(f)}
              onClick={() => setPicked((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n })} />
            <button className="x" aria-label="Not a face / ignore" title="Ignore this face" data-testid="face-ignore" onClick={() => void ppl.ignore([f.id])}>×</button>
          </FaceImg>
        ))}
        {faces.length > 24 && <span className="muted">+{faces.length - 24}</span>}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <input list="people-names" data-testid="cluster-name" placeholder={picked.size ? `Who are the ${picked.size} selected?` : faces.length > 1 ? `Who are these ${faces.length}?` : 'Who is this?'}
          value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="words" enterKeyHint="done" />
        <button className="btn primary" data-testid="cluster-save" disabled={!name.trim()}>Name</button>
      </form>
    </div>
  )
}

function Suggestions({ person, faces }: { person: Person; faces: Face[] }) {
  const ppl = usePeople()
  return (
    <div className="suggest" data-testid="suggestions" data-person={person.name}>
      <div className="row wrap">
        <b className="grow">{person.name}?</b>
        <button className="btn small primary" data-testid="confirm-all" onClick={() => void ppl.confirm(faces.map((f) => f.id))}>Yes to all {faces.length}</button>
      </div>
      <div className="faces">
        {faces.map((f) => (
          // buttons sit below the face so they never cover it
          <div key={f.id} className="suggestion" data-testid="suggestion" data-face={f.id} data-photo={f.photoId}>
            <FaceImg f={f} testId="suggestion-face">
              <small className="dist">{ppl.suggestions.get(f.id)?.distance.toFixed(2)}</small>
            </FaceImg>
            <div className="yn">
              <button aria-label={`Yes, this is ${person.name}`} data-testid="suggest-yes" onClick={() => void ppl.confirm([f.id])}>✓</button>
              <button aria-label={`No, not ${person.name}`} data-testid="suggest-no" onClick={() => void ppl.reject([f.id], person.id)}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PersonPanel({ person, onClose, onShowPhotos }: { person: Person; onClose: () => void; onShowPhotos: (tag: string) => void }) {
  const ppl = usePeople()
  const [name, setName] = useState(person.name)
  const [into, setInto] = useState('')
  const [armed, setArmed] = useState(false)
  const mine = ppl.faces.filter((f) => f.personId === person.id && f.status === 'confirmed')
  const others = ppl.people.filter((p) => p.id !== person.id)
  return (
    <div className="person-panel" data-testid="person-panel">
      <div className="row wrap">
        <h3 className="grow">{person.name}</h3>
        <button className="btn small" data-testid="person-photos" onClick={() => onShowPhotos(person.name)}>Show photos</button>
        <button className="btn icon" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="faces">
        {mine.map((f) => (
          <FaceImg key={f.id} f={f} testId="person-face">
            <button className="x" aria-label={`Not ${person.name}`} title={`Not ${person.name}`} data-testid="person-face-remove" onClick={() => void ppl.reject([f.id], person.id)}>×</button>
          </FaceImg>
        ))}
      </div>
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void ppl.rename(person.id, name) }}>
        <input list="people-names" data-testid="person-rename" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
        <button className="btn" data-testid="person-rename-save" disabled={!name.trim() || name === person.name}>Rename</button>
      </form>
      {others.length > 0 && (
        <div className="row wrap">
          <select data-testid="person-merge-into" value={into} onChange={(e) => setInto(e.target.value)} aria-label="Merge into">
            <option value="">Merge into…</option>
            {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button className="btn" data-testid="person-merge" disabled={!into} onClick={() => { void ppl.merge(person.id, into); onClose() }}>Merge</button>
        </div>
      )}
      <button className={`btn danger ${armed ? 'armed' : ''}`} data-testid="person-delete" onClick={() => {
        if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 4000); return }
        void ppl.deletePerson(person.id); onClose()
      }}>{armed ? 'Click again to delete' : 'Delete person'}</button>
      <small className="muted"> Deleting a person keeps the photos; their faces go back to “Unnamed”.</small>
    </div>
  )
}
