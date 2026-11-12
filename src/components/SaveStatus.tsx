import { useEffect, useRef, useState } from 'react'
import * as Remote from '../remote'

/** Header status for the Dropbox write queue: progress while saving, and a list of photos that could not be saved. */
export function SaveStatus() {
  const [st, setSt] = useState<Remote.SaveStatus>(() => Remote.saveStatus())
  const [open, setOpen] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => Remote.onSaveStatus(setSt), [])
  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); setOpen(false) } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [open])
  useEffect(() => { if (!st.failures.length) setOpen(false) }, [st.failures.length])
  const saving = st.remaining > 0
  const removing = st.removeTotal > 0
  const trashing = st.trashTotal > 0
  const trashFails = st.failures.filter((f) => f.op === 'trash')
  const saveFails = st.failures.length - trashFails.length
  const needSignIn = trashFails.some((f) => f.kind === 'permission' || f.kind === 'auth')
  if (!saving && !removing && !trashing && !st.failures.length) return null
  return (
    <div className="banner save-status" role="status" data-testid="save-status">
      {saving && (
        <div className="bar-line" data-testid="save-progress">
          <span>Saving tags to Dropbox: {st.done} of {st.total} photo{st.total === 1 ? '' : 's'} · {st.remaining} remaining
            {st.retrying > 0 && <> · <span data-testid="save-retrying">retrying {st.retrying}{st.retryReason ? ` (${st.retryReason})` : ''}</span></>}
          </span>
          <div className="bar"><i style={{ width: `${st.total ? Math.min(100, (st.done / st.total) * 100) : 0}%` }} /></div>
        </div>
      )}
      {removing && (
        <div className="bar-line" data-testid="remove-progress">
          <span>Removing from app: {st.removeDone} of {st.removeTotal}{!saving && st.retrying > 0 && <> · <span data-testid="remove-retrying">retrying{st.retryReason ? ` (${st.retryReason})` : ''}</span></>}</span>
          <div className="bar"><i style={{ width: `${Math.min(100, (st.removeDone / st.removeTotal) * 100)}%` }} /></div>
        </div>
      )}
      {trashing && (
        <div className="bar-line" data-testid="deldbx-progress">
          <span>Deleting from Dropbox: {st.trashDone} of {st.trashTotal}{!saving && st.retrying > 0 && <> · <span data-testid="deldbx-retrying">retrying{st.retryReason ? ` (${st.retryReason})` : ''}</span></>}</span>
          <div className="bar deldbx-bar"><i style={{ width: `${Math.min(100, (st.trashDone / st.trashTotal) * 100)}%` }} /></div>
        </div>
      )}
      {needSignIn && (
        <div className="bar-line" data-testid="deldbx-signin">
          <span>⚠ Photo Tagger isn't allowed to delete files in your Dropbox. Sign in to Dropbox again (Settings → Dropbox → Disconnect, then Connect Dropbox), then Retry.</span>
        </div>
      )}
      {st.failures.length > 0 && (
        <div className="bar-line">
          <span data-testid="save-failed-count">⚠ {[
            saveFails ? `${saveFails} photo${saveFails === 1 ? '' : 's'} could not be fully saved to Dropbox.` : '',
            trashFails.length ? `${trashFails.length} photo${trashFails.length === 1 ? ' was' : 's were'} not deleted from Dropbox.` : '',
          ].filter(Boolean).join(' ')}</span>
          <button type="button" className="btn small" data-testid="save-failures-open" onClick={() => setOpen(true)}>View</button>
          <button type="button" className="btn small" data-testid="save-retry-now" onClick={() => Remote.retryFailed()}>Retry now</button>
        </div>
      )}
      {open && (
        <div className="modal sheet" role="dialog" aria-modal="true" aria-label="Photos not saved to Dropbox" data-testid="save-failures">
          <div className="settings-card verify-card">
            <div className="settings-head"><h2>Not saved to Dropbox</h2><button ref={closeRef} className="btn icon" aria-label="Close list" onClick={() => setOpen(false)}>✕</button></div>
            <div className="settings-body">
              {trashFails.length > 0 && <p className="muted small" data-testid="deldbx-fail-note">Photos not deleted from Dropbox are out of Photo Tagger already and their files are still in your Dropbox. Retry deletes them; Refresh won't add them back meanwhile.</p>}
              <p className="muted small">These photos' tags are still in Photo Tagger but did not (fully) reach Dropbox. Fix the reason if needed, then Retry now. Temporary problems (rate limits, network, Dropbox outages) are retried automatically and only show here after a long time.</p>
              <ul className="verify-list" data-testid="save-failure-list">
                {st.failures.map((f) => (
                  <li key={f.id} data-testid="save-failure" data-name={f.name} data-kind={f.kind} data-op={f.op ?? 'save'}>
                    <b>{f.name}</b>
                    <p>{f.reason}</p>
                    <button type="button" className="btn small" onClick={() => Remote.retryFailed([f.id])}>Retry</button>
                  </li>
                ))}
              </ul>
              <div className="row wrap">
                <button type="button" className="btn primary" data-testid="save-retry-all" onClick={() => Remote.retryFailed()}>Retry now</button>
                <button type="button" className="btn" data-testid="save-dismiss" onClick={() => { Remote.dismissFailures(); setOpen(false) }}>Dismiss list</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
