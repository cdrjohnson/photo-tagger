import { useEffect, useRef, useState } from 'react'
import type { Photo } from '../types'
import { verifyDropboxTags } from '../remote'
import { tagVerificationError, type TagVerification } from '../tagVerification'

/** Shared selected-photos and whole-library action. Results stay on screen until dismissed. */
export function VerifyDropboxTags({ photos, library = false }: { photos: Photo[]; library?: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [rows, setRows] = useState<TagVerification[]>([])
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [issuesOnly, setIssuesOnly] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const close = () => { setOpen(false); triggerRef.current?.focus() }
  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); close() }
      if (e.key === 'Tab') {
        const els = [...(cardRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select') ?? [])]
        const first = els[0], last = els.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [open])
  const run = async () => {
    setOpen(true); setBusy(true); setRows([]); setError(''); setQuery(''); setIssuesOnly(false)
    setProgress('Saving pending edits to Dropbox…')
    try {
      setRows(await verifyDropboxTags(photos, (done, total) => setProgress(`Checked ${done} of ${total} files`)))
    } catch (e) { setError(tagVerificationError(e)) }
    finally { setBusy(false) }
  }
  const checked = rows.filter((r) => !r.error && !r.skipped)
  const issues = rows.filter((r) => r.error || r.missing.length)
  const q = query.trim().toLowerCase()
  const shown = rows.filter((r) => (!issuesOnly || r.error || r.missing.length) && (!q || `${r.name} ${r.landed.join(' ')} ${r.missing.join(' ')}`.toLowerCase().includes(q)))
  return <>
    <button ref={triggerRef} className="btn" data-testid={library ? 'verify-dropbox-library' : 'verify-dropbox-selected'} disabled={!photos.length || busy} onClick={() => void run()}>
      {library ? 'Verify Dropbox tags — whole library' : 'Verify Dropbox tags'}
    </button>
    {open && <div className="modal sheet" role="dialog" aria-modal="true" aria-label="Verify Dropbox tags" data-testid="verify-dropbox-results">
      <div className="settings-card verify-card" ref={cardRef}>
        <div className="settings-head"><h2>Verify Dropbox tags</h2><button ref={closeRef} className="btn icon" onClick={close} aria-label="Close verification">✕</button></div>
        <div className="settings-body">
          <p className="muted small">Reads Dropbox's Tags API after saving pending edits. No photos or videos are downloaded. Dropbox's web file info can be cached; these are the tags actually read from the file.</p>
          {busy && <p role="status" data-testid="verify-progress">{progress}</p>}
          {error && <p className="note warn" role="alert">{error}</p>}
          {!busy && !error && <>
            <p data-testid="verify-summary" role="status">{checked.length} Dropbox file(s) checked · {rows.filter((r) => r.skipped).length} skipped · {rows.filter((r) => r.error).length} errors · {issues.filter((r) => r.missing.length).length} with missing tags.</p>
            {!issues.length && checked.length > 0 && <p className="note" data-testid="verify-all-good">Every desired tag was found on Dropbox.</p>}
            {!rows.length && <p>No files to check.</p>}
            <div className="row wrap">
              <input className="grow" type="search" placeholder="Search verification results…" aria-label="Search verification results" value={query} onChange={(e) => setQuery(e.target.value)} />
              <label className="check"><input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} />Only missing tags / errors</label>
            </div>
            <ul className="verify-list" data-testid="verify-list">
              {shown.map((r) => <li key={r.id} data-testid="verify-row" data-name={r.name}>
                <b>{r.name}</b>
                {r.skipped ? <p className="muted">{r.skipped}</p> : r.error ? <p className="note warn" role="alert">{r.error}</p> : <>
                  <small className="muted">{r.nativeCount} of 20 Dropbox tag slots used</small>
                  {r.pending && <p className="note warn" data-testid="verify-pending">{r.pending}</p>}
                  <p data-testid="verify-landed"><strong>Landed ({r.landed.length}):</strong> {r.landed.join(', ') || 'No desired tags on this photo.'}</p>
                  <p className={r.missing.length ? 'verify-missing' : 'muted'} data-testid="verify-missing"><strong>Missing ({r.missing.length}):</strong> {r.missing.join(', ') || 'None'}</p>
                  {r.atCap.length > 0 && <p className="note warn" data-testid="verify-cap"><strong>Could not be written because the file already has 20 tags:</strong> {r.atCap.join(', ')}. Tags added by you or other apps keep their slots.</p>}
                </>}
              </li>)}
            </ul>
            {!shown.length && rows.length > 0 && <p>No matching results.</p>}
          </>}
        </div>
      </div>
    </div>}
  </>
}
