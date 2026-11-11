import { useEffect, useRef, useState } from 'react'
import * as Remote from '../remote'
import { useLibrary } from '../store'
import { RemoveConfirm } from './RemoveConfirm'

/**
 * "N photos are no longer in Dropbox" (1.0.28): files deleted from Dropbox. Moved or renamed files are followed by
 * their Dropbox id and never show here. Nothing is retried or deleted in Dropbox; Remove from app only forgets them.
 */
export function MissingFiles() {
  const lib = useLibrary()
  const [list, setList] = useState<Remote.MissingFile[]>(() => Remote.saveStatus().missing)
  const [open, setOpen] = useState(false)
  const [ask, setAsk] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => Remote.onSaveStatus((s) => setList((prev) => (prev.length === s.missing.length && prev.every((m, i) => m.id === s.missing[i]?.id) ? prev : s.missing))), [])
  useEffect(() => { if (!list.length) { setOpen(false); setAsk(false) } }, [list.length])
  useEffect(() => {
    if (!open || ask) return
    closeRef.current?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); setOpen(false) } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [open, ask])
  if (!list.length) return null
  const n = list.length, one = n === 1
  return (
    <div className="banner missing-files" role="status" data-testid="missing-files">
      <div className="bar-line">
        <span data-testid="missing-count">{n} photo{one ? ' is' : 's are'} no longer in Dropbox</span>
        <button type="button" className="btn small" data-testid="missing-view" onClick={() => setOpen(true)}>View</button>
        <button type="button" className="btn small" data-testid="missing-remove" onClick={() => setAsk(true)}>Remove from app</button>
        <button type="button" className="btn small" data-testid="missing-dismiss" onClick={() => { Remote.dismissMissing(); setOpen(false) }}>Dismiss</button>
      </div>
      {open && (
        <div className="modal sheet" role="dialog" aria-modal="true" aria-label="No longer in Dropbox" data-testid="missing-list-dialog">
          <div className="settings-card verify-card">
            <div className="settings-head"><h2>No longer in Dropbox</h2><button ref={closeRef} className="btn icon" aria-label="Close list" onClick={() => setOpen(false)}>✕</button></div>
            <div className="settings-body">
              <p className="muted small">{one ? 'This file was' : 'These files were'} deleted from Dropbox (or Photo Tagger can no longer see {one ? 'it' : 'them'}). Files you moved or renamed in Dropbox are followed automatically and don't show here. Their tags are still in Photo Tagger. If you restore {one ? 'the file' : 'a file'} in Dropbox, it is picked up again on the next start. Remove from app forgets {one ? 'it' : 'them'} here — nothing is deleted in Dropbox.</p>
              <ul className="verify-list" data-testid="missing-list">
                {list.map((m) => (
                  <li key={m.id} data-testid="missing-file" data-name={m.name}><b>{m.name}</b><p className="muted small">was at {m.path || '(unknown path)'}</p></li>
                ))}
              </ul>
              <div className="row wrap">
                <button type="button" className="btn danger" data-testid="missing-remove-all" onClick={() => setAsk(true)}>Remove from app</button>
                <button type="button" className="btn" data-testid="missing-dismiss-list" onClick={() => { Remote.dismissMissing(); setOpen(false) }}>Dismiss</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {ask && (
        <RemoveConfirm count={n} onCancel={() => setAsk(false)}
          onConfirm={async () => { setAsk(false); setOpen(false); await lib.deletePhotos(list.map((m) => m.id)) }} />
      )}
    </div>
  )
}
