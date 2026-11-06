import { useEffect, useState } from 'react'
import { useLibrary, type NearDupe } from '../store'
import { useThumb } from '../hooks'

function Thumb({ id, name }: { id?: string; name: string; blobUrl?: string }) {
  const url = useThumb(id ?? '')
  return (
    <div className="dupe-thumb">
      {url ? <img src={url} alt={name} /> : <div className="ph" />}
      <small title={name}>{name}</small>
    </div>
  )
}

function IngestThumb({ prep }: { prep: NearDupe['prep'] }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!prep) return
    const u = URL.createObjectURL(prep.blobs.thumb)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [prep])
  return (
    <div className="dupe-thumb">
      {url ? <img src={url} alt={prep?.photo.name} /> : <div className="ph" />}
      <small title={prep?.photo.name}>{prep?.photo.name}</small>
    </div>
  )
}

export function DupeReview() {
  const lib = useLibrary()
  useEffect(() => {
    if (!lib.nearDupes.length) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void lib.resolveAllNearDupes('skip')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lib.nearDupes.length, lib])
  if (!lib.nearDupes.length) return null
  return (
    <div className="modal sheet" role="dialog" aria-modal="true" aria-label="Near duplicates" data-testid="dupe-review">
      <div className="sheet-card dupe-card">
        <div className="settings-head">
          <h2>Near duplicates <small>{lib.nearDupes.length}</small></h2>
          <div className="row wrap">
            <button className="btn small" data-testid="dupe-skip-all" onClick={() => void lib.resolveAllNearDupes('skip')}>Skip all</button>
            <button className="btn small" data-testid="dupe-keep-all" onClick={() => void lib.resolveAllNearDupes('keep')}>Keep all</button>
          </div>
        </div>
        <p className="muted">These photos look very similar. Skip the new one, keep both, or mark the new one as a duplicate of the existing photo.</p>
        <div className="dupe-list" data-testid="dupe-list">
          {lib.nearDupes.map((n) => (
            <div key={n.id} className="dupe-row" data-testid="dupe-row" data-name={n.name} data-match={n.matchName} data-distance={n.distance}>
              {n.kind === 'ingest' && n.prep ? <IngestThumb prep={n.prep} /> : <Thumb id={n.id} name={n.name} />}
              <div className="dupe-meta">
                <b>{n.kind === 'ingest' ? 'New' : 'In library'}</b>
                <span className="muted">vs</span>
                <b>Existing</b>
                <small data-testid="dupe-distance">distance {n.distance}</small>
              </div>
              <Thumb id={n.matchId} name={n.matchName} />
              <div className="dupe-actions">
                <button className="btn small" data-testid="dupe-skip" onClick={() => void lib.resolveNearDupe(n.id, 'skip')}>
                  {n.kind === 'ingest' ? 'Skip new' : 'Dismiss'}
                </button>
                <button className="btn small" data-testid="dupe-keep" onClick={() => void lib.resolveNearDupe(n.id, 'keep')}>
                  {n.kind === 'ingest' ? 'Keep both' : 'Not a duplicate'}
                </button>
                <button className="btn small primary" data-testid="dupe-mark" onClick={() => void lib.resolveNearDupe(n.id, 'mark')}>
                  Mark as duplicate
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
