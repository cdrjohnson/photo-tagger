import { useEffect, useRef, useState } from 'react'
import { META_TAGS } from '../tags'
import { DEFAULT_LABELS } from '../labels'
import { useLibrary } from '../store'

/**
 * "Check your detection list first" — shown before the first Dropbox import into an empty library (1.0.27).
 * Nothing is downloaded or analysed until the user picks "Tag with these settings".
 * Focus starts on "Review detection list" (safe), so Enter never starts an import by itself.
 */
export function PreImportCheck({ onReview }: { onReview: () => void }) {
  const lib = useLibrary()
  const [dont, setDont] = useState(false)
  const reviewRef = useRef<HTMLButtonElement>(null)
  const open = lib.preImportAsk
  const dontRef = useRef(dont); dontRef.current = dont
  useEffect(() => {
    if (!open) return
    setDont(false)
    reviewRef.current?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); lib.answerPreImport('cancel', dontRef.current) } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  if (!open) return null
  const s = lib.settings
  const offLabels = new Set(s.disabledLabels)
  const builtinOn = DEFAULT_LABELS.filter((l) => !offLabels.has(l.id)).length
  const customOn = lib.custom.filter((c) => !offLabels.has(c.id))
  const offMeta = new Set(s.disabledMetaTags ?? [])
  const metaOn = META_TAGS.filter((m) => !offMeta.has(m.id))
  const metaOff = META_TAGS.filter((m) => offMeta.has(m.id))
  // 1.0.33: new setups start with every automatic tag off — say so plainly instead of "check your list"
  const allOff = builtinOn === 0 && customOn.length === 0 && metaOn.length === 0
  return (
    <div className="modal sheet" role="dialog" aria-modal="true" aria-labelledby="preimport-title" aria-describedby="preimport-desc" data-testid="preimport-check"
      onClick={(e) => e.stopPropagation()}>
      <div className="sheet-card preimport">
        <div className="settings-head">
          <h2 id="preimport-title">{allOff ? 'Automatic tags are off' : 'Check your detection list first'}</h2>
          <button className="btn icon" aria-label="Cancel" data-testid="preimport-dismiss" onClick={() => lib.answerPreImport('cancel', dont)}>✕</button>
        </div>
        {allOff
          ? <p id="preimport-desc" data-testid="preimport-all-off">Automatic tags are off, so the photos you import get <b>no automatic tags</b> — only the tags you add yourself{s.faceEnabled ? ' (faces are still found so you can name people)' : ''}. Review the detection list to turn on the tags you want (or <b>Turn all on</b>), or import without automatic tags.</p>
          : <p id="preimport-desc">Photo Tagger will automatically add tags to every photo you import, using your <b>Detection list</b> and <b>Photo metadata</b> settings, and save them to Dropbox. It's easiest to adjust these before the first import.</p>}
        <ul className="preimport-summary" data-testid="preimport-summary">
          <li data-testid="preimport-detect"><b>{builtinOn}</b> of {DEFAULT_LABELS.length} built-in detection tags on{customOn.length ? <> · <b>{customOn.length}</b> custom tag{customOn.length === 1 ? '' : 's'} ({customOn.slice(0, 4).map((c) => c.label).join(', ')}{customOn.length > 4 ? '…' : ''})</> : ' · no custom tags'}</li>
          <li data-testid="preimport-meta">Photo metadata: {metaOn.length ? <>on — {metaOn.map((m) => m.label).join(', ')}</> : 'all off'}{metaOff.length > 0 && metaOn.length > 0 && <span className="muted"> · off — {metaOff.map((m) => m.label).join(', ')}</span>}</li>
          <li data-testid="preimport-faces">Face recognition: {s.faceEnabled ? 'on' : 'off'} · up to {s.maxTags} detected tags per photo</li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={dont} onChange={(e) => setDont(e.target.checked)} data-testid="preimport-dont-ask" />
          <span>Don't show this again <small>Turn it back on in Settings → Dropbox.</small></span>
        </label>
        <div className="row wrap" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" data-testid="preimport-cancel" onClick={() => lib.answerPreImport('cancel', dont)}>Cancel</button>
          <button type="button" ref={reviewRef} className="btn" data-testid="preimport-review" onClick={() => { lib.answerPreImport('review', dont); onReview() }}>Review detection list</button>
          <button type="button" className="btn primary" data-testid="preimport-proceed" onClick={() => lib.answerPreImport('proceed', dont)}>{allOff ? 'Import without automatic tags' : 'Tag with these settings'}</button>
        </div>
      </div>
    </div>
  )
}
