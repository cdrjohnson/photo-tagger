import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useViewUrl } from '../hooks'
import { useLibrary } from '../store'
import { getBlob } from '../storage'
import type { Photo } from '../types'
import { TagInput } from './TagInput'
import { usePeople } from '../people'

const fmtSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`)
const SRC_LABEL = { person: 'People (from faces)', auto: 'Detected in image', manual: 'Added by you', exif: 'From photo metadata', quality: 'Quality check' } as const

const MIN_ZOOM = 1
const MAX_ZOOM = 8
const ZOOM_STEP = 1.25

export function Detail({ list, index, onIndex, onClose, allTags }: {
  list: Photo[]; index: number; onIndex: (i: number) => void; onClose: () => void; allTags: string[]
}) {
  const lib = useLibrary()
  const ppl = usePeople()
  const p = list[index]
  const url = useViewUrl(p?.id)

  // zoom=1 means fit-to-frame; higher values magnify. Pan is in CSS pixels of the viewport.
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null)

  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [])

  // Reset fit when navigating to another photo
  useEffect(() => { resetView() }, [p?.id, resetView])

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

  const zoomBy = useCallback((factor: number, origin?: { x: number; y: number }) => {
    setZoom((prev) => {
      const next = clampZoom(prev * factor)
      if (next === prev) return prev
      if (origin && stageRef.current) {
        const rect = stageRef.current.getBoundingClientRect()
        const cx = origin.x - rect.left - rect.width / 2
        const cy = origin.y - rect.top - rect.height / 2
        // Keep the point under the cursor stable while scaling
        setPan((p0) => ({
          x: cx - ((cx - p0.x) * next) / prev,
          y: cy - ((cy - p0.y) * next) / prev,
        }))
      }
      if (next === 1) setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

  const setZoomExact = useCallback((z: number) => {
    const next = clampZoom(z)
    setZoom(next)
    if (next <= 1) setPan({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') { if (e.key === 'Escape') onClose(); return }
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight' && index < list.length - 1) onIndex(index + 1)
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(ZOOM_STEP) }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / ZOOM_STEP) }
      if (e.key === '0') { e.preventDefault(); resetView() }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [index, list.length, onClose, onIndex, zoomBy, resetView])

  useEffect(() => { if (!p) onClose() }, [p, onClose])

  // Non-passive wheel listener so preventDefault actually stops page scroll
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      zoomBy(factor, { x: e.clientX, y: e.clientY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomBy, p?.id])

  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom <= 1) return
    if (e.pointerType === 'touch') return // pinch handled separately
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setPan({ x: d.panX + (e.clientX - d.x), y: d.panY + (e.clientY - d.y) })
  }
  const onPointerUp = () => { dragRef.current = null }

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]]
      pinchRef.current = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom }
      dragRef.current = null
    } else if (e.touches.length === 1 && zoom > 1) {
      const t = e.touches[0]
      dragRef.current = { x: t.clientX, y: t.clientY, panX: pan.x, panY: pan.y }
    }
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault()
      const [a, b] = [e.touches[0], e.touches[1]]
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const next = clampZoom(pinchRef.current.zoom * (dist / pinchRef.current.dist))
      setZoom(next)
      if (next <= 1) setPan({ x: 0, y: 0 })
    } else if (e.touches.length === 1 && dragRef.current) {
      const t = e.touches[0]
      const d = dragRef.current
      setPan({ x: d.panX + (t.clientX - d.x), y: d.panY + (t.clientY - d.y) })
    }
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) pinchRef.current = null
    if (e.touches.length === 0) dragRef.current = null
  }

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

  const pct = Math.round(zoom * 100)

  return (
    <div className="modal detail" role="dialog" aria-modal="true" aria-label={`Photo ${p.name}`} data-testid="detail">
      <div className="detail-stage">
        <div className="detail-bar">
          <button className="btn icon" onClick={onClose} aria-label="Close" data-testid="detail-close">✕</button>
          <span className="detail-count">{index + 1} / {list.length}</span>
          <span className="spacer" />
          <div className="detail-zoom" role="group" aria-label="Zoom">
            <button type="button" className="btn icon" data-testid="detail-zoom-out" aria-label="Zoom out"
              disabled={zoom <= MIN_ZOOM} onClick={() => zoomBy(1 / ZOOM_STEP)}>−</button>
            <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={0.05} value={zoom}
              data-testid="detail-zoom-slider" aria-label={`Zoom ${pct}%`}
              onChange={(e) => setZoomExact(Number(e.target.value))} />
            <button type="button" className="btn icon" data-testid="detail-zoom-in" aria-label="Zoom in"
              disabled={zoom >= MAX_ZOOM} onClick={() => zoomBy(ZOOM_STEP)}>＋</button>
            <button type="button" className="btn small" data-testid="detail-zoom-reset" aria-label="Fit to frame"
              disabled={zoom === 1 && pan.x === 0 && pan.y === 0} onClick={resetView}>{pct}%</button>
          </div>
          <button className="btn icon" onClick={() => onIndex(index - 1)} disabled={index === 0} aria-label="Previous photo" data-testid="detail-prev">‹</button>
          <button className="btn icon" onClick={() => onIndex(index + 1)} disabled={index >= list.length - 1} aria-label="Next photo" data-testid="detail-next">›</button>
        </div>
        <div
          className={`detail-img${zoom > 1 ? ' zoomed' : ''}`}
          data-testid="detail-viewport"
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {url
            ? <img
                src={url}
                alt={p.name}
                data-testid="detail-img"
                data-zoom={String(zoom)}
                draggable={false}
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              />
            : <div className="spinner" />}
        </div>
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
