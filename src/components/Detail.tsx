import { useEffect, useMemo } from 'react'
import { useViewUrl } from '../hooks'
import { useLibrary } from '../store'
import { getBlob } from '../db'
import type { Photo } from '../types'
import { TagInput } from './TagInput'
import { usePeople } from '../people'

const fmtSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`)
const SRC_LABEL = { person: 'People (from faces)', auto: 'Detected in image', manual: 'Added by you', exif: 'From photo metadata', quality: 'Quality check' } as const

export function Detail({ list, index, onIndex, onClose, allTags }: {
  list: Photo[]; index: number; onIndex: (i: number) => void; onClose: () => void; allTags: string[]
}) {
  const lib = useLibrary()
  const ppl = usePeople()
  const p = list[index]
  const url = useViewUrl(p?.id)

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') { if (e.key === 'Escape') onClose(); return }
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight' && index < list.length - 1) onIndex(index + 1)
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [index, list.length, onClose, onIndex])

  useEffect(() => { if (!p) onClose() }, [p, onClose])

  const groups = useMemo(() => {
    const g: Record<string, Photo['tags']> = {}
    for (const t of p?.tags ?? []) (g[t.source] ??= []).push(t)
    return g
  }, [p])
  if (!p) return null

  const retagOne = () => lib.retagPhoto(p.id)

  const download = async () => {
    const blob = (await getBlob('originals', p.id)) ?? (await getBlob('views', p.id))
    if (!blob) return
    const u = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = u; a.download = p.name; a.click()
    setTimeout(() => URL.revokeObjectURL(u), 2000)
  }

  return (
    <div className="modal detail" role="dialog" aria-modal="true" aria-label={`Photo ${p.name}`} data-testid="detail">
      <div className="detail-stage">
        <div className="detail-bar">
          <button className="btn icon" onClick={onClose} aria-label="Close" data-testid="detail-close">✕</button>
          <span className="detail-count">{index + 1} / {list.length}</span>
          <span className="spacer" />
          <button className="btn icon" onClick={() => onIndex(index - 1)} disabled={index === 0} aria-label="Previous photo" data-testid="detail-prev">‹</button>
          <button className="btn icon" onClick={() => onIndex(index + 1)} disabled={index >= list.length - 1} aria-label="Next photo" data-testid="detail-next">›</button>
        </div>
        <div className="detail-img">{url ? <img src={url} alt={p.name} data-testid="detail-img" /> : <div className="spinner" />}</div>
      </div>
      <aside className="detail-side">
        <h2 title={p.name} data-testid="detail-name">{p.name}</h2>
        {p.status === 'pending' && <p className="note warn">Not tagged yet. Auto-tags appear once the model has run.</p>}
        <section>
          <h3>Tags</h3>
          {(['person', 'manual', 'auto', 'exif', 'quality'] as const).map((s) => groups[s] && (
            <div key={s} className="tag-group">
              <div className="tag-group-label">{SRC_LABEL[s]}</div>
              <div className="chips">
                {groups[s].map((t) => (
                  <span key={t.name} className={`chip src-${t.source} static`} data-testid="detail-tag" data-tag={t.name}>
                    {t.name}{t.score != null && <small>{Math.round(t.score * 100)}%</small>}
                    <button aria-label={`Remove tag ${t.name}`} data-testid="remove-tag" onClick={() => (t.source === 'person' ? ppl.rejectOnPhotos([p.id], t.name) : lib.removeTags([p.id], [t.name]))}>×</button>
                  </span>
                ))}
              </div>
            </div>
          ))}
          {!p.tags.length && <p className="muted">No tags yet.</p>}
          <TagInput suggestions={allTags} onAdd={(n) => lib.addTags([p.id], n)} testId="detail-tag-input" />
        </section>
        <section>
          <h3>Details</h3>
          <dl className="meta">
            <dt>Taken</dt><dd>{p.takenAt ? new Date(p.takenAt).toLocaleString() : '—'}<small> ({p.dateSource === 'exif' ? 'from EXIF' : p.dateSource === 'file' ? 'file date' : 'date added'})</small></dd>
            <dt>Camera</dt><dd>{p.camera ?? '—'}</dd>
            <dt>Location</dt>
            <dd>{p.gps
              ? <a href={`https://www.openstreetmap.org/?mlat=${p.gps.lat}&mlon=${p.gps.lon}#map=14/${p.gps.lat}/${p.gps.lon}`} target="_blank" rel="noreferrer noopener" data-testid="gps">{p.gps.lat.toFixed(4)}, {p.gps.lon.toFixed(4)}</a>
              : 'No GPS data'}</dd>
            <dt>Size</dt><dd>{p.width} × {p.height} · {fmtSize(p.size)}</dd>
            <dt>Sharpness</dt><dd>{p.quality.sharpness}{p.quality.blurry ? ' (blurry)' : ''}</dd>
            <dt>Brightness</dt><dd>{Math.round(p.quality.brightness)} / 255{p.quality.dark ? ' (dark)' : p.quality.bright ? ' (bright)' : ''}</dd>
            <dt>Faces</dt><dd data-testid="face-count">{p.facesScanned ? p.faceCount ?? 0 : 'not checked'}</dd>
            <dt>Source</dt><dd>{p.source === 'dropbox' ? 'Dropbox' : 'This device'}</dd>
          </dl>
        </section>
        <div className="row wrap">
          <button className="btn" onClick={retagOne}>Re-run tagging</button>
          <button className="btn" onClick={download} data-testid="download">{p.hasOriginal ? 'Download original' : 'Download copy'}</button>
          <button className="btn danger" data-testid="delete-photo" onClick={async () => {
            const next = list[index + 1] ?? list[index - 1]
            await lib.deletePhotos([p.id])
            if (!next) onClose()
            else onIndex(Math.min(index, list.length - 2))
          }}>Delete</button>
        </div>
      </aside>
    </div>
  )
}
