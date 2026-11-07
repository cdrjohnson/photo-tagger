import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useViewUrl } from '../hooks'
import { useLibrary } from '../store'
import { getBlob } from '../storage'
import { fetchDropboxOriginal } from '../dropbox'
import type { Photo } from '../types'
import { TagInput } from './TagInput'
import { usePeople } from '../people'

const fmtSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`)
const SRC_LABEL = { person: 'People (from faces)', auto: 'Detected in image', manual: 'Added by you', dropbox: 'From Dropbox', exif: 'From photo metadata', quality: 'Quality check' } as const

// Zoom is the real display scale: 1 = 100% = native pixels (1:1).
// "Fit" is computed per photo/viewport and is often well below 100% for large photos.
const MIN_ZOOM_FLOOR = 0.05
const MAX_ZOOM = 8
const ZOOM_STEP = 1.25
const EPS = 0.001

export function Detail({ list, index, onIndex, onClose, allTags }: {
  list: Photo[]; index: number; onIndex: (i: number) => void; onClose: () => void; allTags: string[]
}) {
  const lib = useLibrary()
  const ppl = usePeople()
  const p = list[index]
  const url = useViewUrl(p?.id)

  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState(1)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null)
  const fitRef = useRef(1)
  const atFitRef = useRef(true)

  // Allow zooming out below fit (and far below 100%) so every photo can be shrunk.
  const minZoom = Math.max(0.01, Math.min(MIN_ZOOM_FLOOR * 2, fit * 0.5))
  const minRef = useRef(minZoom); minRef.current = minZoom
  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(minRef.current, z))

  const computeFit = useCallback(() => {
    const el = stageRef.current
    if (!el || !nat) return
    const cs = getComputedStyle(el)
    const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    if (w <= 0 || h <= 0) return
    const f = Math.min(1, w / nat.w, h / nat.h)
    fitRef.current = f
    setFit(f)
    if (atFitRef.current) { setZoom(f); setPan({ x: 0, y: 0 }) }
  }, [nat])

  const resetView = useCallback(() => {
    atFitRef.current = true
    setZoom(fitRef.current); setPan({ x: 0, y: 0 })
  }, [])

  // Reset fit when navigating to another photo
  useEffect(() => { atFitRef.current = true; setNat(null); setPan({ x: 0, y: 0 }) }, [p?.id])
  // opening a Dropbox photo picks up tags added/removed in Dropbox (no polling)
  useEffect(() => { if (p?.dropbox) void lib.pullDropboxTags(p.id) }, [p?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { computeFit() }, [computeFit])
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => computeFit())
    ro.observe(el)
    return () => ro.disconnect()
  }, [computeFit])

  const zoomBy = useCallback((factor: number, origin?: { x: number; y: number }) => {
    setZoom((prev) => {
      const next = clampZoom(prev * factor)
      if (Math.abs(next - prev) < 1e-6) return prev
      atFitRef.current = Math.abs(next - fitRef.current) < EPS
      if (next <= fitRef.current + EPS) setPan({ x: 0, y: 0 })
      else if (origin && stageRef.current) {
        const rect = stageRef.current.getBoundingClientRect()
        const cx = origin.x - rect.left - rect.width / 2
        const cy = origin.y - rect.top - rect.height / 2
        // Keep the point under the cursor stable while scaling
        setPan((p0) => ({
          x: cx - ((cx - p0.x) * next) / prev,
          y: cy - ((cy - p0.y) * next) / prev,
        }))
      }
      return next
    })
  }, [])

  const setZoomExact = useCallback((z: number) => {
    const next = clampZoom(z)
    atFitRef.current = Math.abs(next - fitRef.current) < EPS
    setZoom(next)
    if (next <= fitRef.current + EPS) setPan({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLInputElement
      if (tgt?.tagName === 'INPUT' && tgt.type !== 'range') { if (e.key === 'Escape') onClose(); return }
      if (e.key === 'Escape') onClose()
      if (tgt?.type === 'range' && e.key.startsWith('Arrow')) return
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

  const canPan = zoom > fit + EPS

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canPan) return
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
    } else if (e.touches.length === 1 && canPan) {
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
      atFitRef.current = Math.abs(next - fitRef.current) < EPS
      setZoom(next)
      if (next <= fitRef.current + EPS) setPan({ x: 0, y: 0 })
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
    const blob = (p.dropbox && !p.hasOriginal ? await fetchDropboxOriginal(p) : undefined)
      ?? (await getBlob('originals', p.id)) ?? (await getBlob('views', p.id))
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
              disabled={zoom <= minZoom + 1e-6} onClick={() => zoomBy(1 / ZOOM_STEP)}>−</button>
            <input type="range" min={minZoom} max={MAX_ZOOM} step="any" value={zoom}
              data-testid="detail-zoom-slider" aria-label={`Zoom ${pct}%`}
              onChange={(e) => setZoomExact(Number(e.target.value))} />
            <button type="button" className="btn icon" data-testid="detail-zoom-in" aria-label="Zoom in"
              disabled={zoom >= MAX_ZOOM} onClick={() => zoomBy(ZOOM_STEP)}>＋</button>
            <button type="button" className="btn small" data-testid="detail-zoom-reset" aria-label="Fit to frame" title={`Fit (${Math.round(fit * 100)}%)`}
              disabled={Math.abs(zoom - fit) < EPS && pan.x === 0 && pan.y === 0} onClick={resetView}>{pct}%</button>
          </div>
          <button className="btn icon" onClick={() => onIndex(index - 1)} disabled={index === 0} aria-label="Previous photo" data-testid="detail-prev">‹</button>
          <button className="btn icon" onClick={() => onIndex(index + 1)} disabled={index >= list.length - 1} aria-label="Next photo" data-testid="detail-next">›</button>
        </div>
        <div
          className={`detail-img${canPan ? ' zoomed' : ''}`}
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
                data-zoom={String(Math.round(zoom * 1000) / 1000)}
                data-fit={String(Math.round(fit * 1000) / 1000)}
                data-min-zoom={String(Math.round(minZoom * 1000) / 1000)}
                draggable={false}
                onLoad={(e) => { const im = e.currentTarget; setNat({ w: im.naturalWidth, h: im.naturalHeight }) }}
                style={nat
                  ? { width: nat.w, height: nat.h, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }
                  : { visibility: 'hidden' }}
              />
            : <div className="spinner" />}
        </div>
      </div>
      <aside className="detail-side">
        <h2 title={p.name} data-testid="detail-name">{p.name}</h2>
        {p.status === 'pending' && <p className="note warn">Not tagged yet. Auto-tags appear once the model has run.</p>}
        <section>
          <h3>Tags</h3>
          {(['person', 'manual', 'dropbox', 'auto', 'exif', 'quality'] as const).map((s) => groups[s] && (
            <div key={s} className="tag-group" data-testid="tag-group" data-source={s}>
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
            {p.dropbox && <><dt>Dropbox path</dt><dd data-testid="dropbox-path">{p.dropbox.path}</dd></>}
          </dl>
        </section>
        <div className="row wrap">
          <button className="btn" onClick={retagOne}>Re-run tagging</button>
          <button className="btn" onClick={download} data-testid="download">{p.hasOriginal || p.dropbox ? 'Download original' : 'Download copy'}</button>
          <button className="btn danger" data-testid="delete-photo" onClick={async () => {
            const next = list[index + 1] ?? list[index - 1]
            await lib.deletePhotos([p.id])
            if (!next) onClose()
            else onIndex(Math.min(index, list.length - 2))
          }} title={p.dropbox ? 'Removes it from Photo Tagger (and its tags file in /.photo-tagger). The photo stays in your Dropbox.' : undefined}>{p.dropbox ? 'Remove from app' : 'Delete'}</button>
        </div>
      </aside>
    </div>
  )
}
