import { useEffect, useRef } from 'react'

/** In-app "Remove from app?" dialog. Cancel has focus, so Enter or a stray click never confirms by itself. */
export function RemoveConfirm({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onCancel() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onCancel])
  const one = count === 1
  return (
    <div className="modal sheet" role="alertdialog" aria-modal="true" aria-labelledby="remove-title" aria-describedby="remove-desc" data-testid="remove-confirm"
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="sheet-card">
        <div className="settings-head">
          <h2 id="remove-title">{one ? 'Remove this photo from the app?' : `Remove ${count} photos from the app?`}</h2>
          <button className="btn icon" aria-label="Close" data-testid="remove-dismiss" onClick={onCancel}>✕</button>
        </div>
        <p id="remove-desc">{one ? "The file itself isn't deleted" : "The files themselves aren't deleted"} — originals elsewhere (including Dropbox) are not affected. {one ? 'It' : 'They'} only {one ? 'leaves' : 'leave'} Photo Tagger: {one ? 'its' : 'their'} tags stay on the Dropbox {one ? 'file' : 'files'} and are saved for later, and Add next batch / Refresh won't bring {one ? 'it' : 'them'} back. To add {one ? 'it' : 'them'} again, tick {one ? 'it' : 'them'} under <b>Removed from app</b> in Pick specific photos — tags and face names come back.</p>
        <div className="row wrap" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" ref={cancelRef} className="btn" data-testid="remove-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn danger" data-testid="remove-confirm-btn" onClick={onConfirm}>Remove from app</button>
        </div>
      </div>
    </div>
  )
}
