import { useEffect, useRef } from 'react'
import type { Photo } from '../types'
import { useThumb } from '../hooks'

function Mini({ id }: { id: string }) { const u = useThumb(id); return u ? <img src={u} alt="" /> : <span className="deldbx-ph">🖼</span> }

/** 1.0.33 "Delete from Dropbox?" confirmation. Cancel has focus (Enter = Cancel); Esc cancels. */
export function DeleteDropboxConfirm({ photos, skipped = 0, onCancel, onConfirm }: { photos: Photo[]; skipped?: number; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onCancel() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onCancel])
  const n = photos.length, one = n === 1
  const shown = photos.slice(0, 6)
  return (
    <div className="modal sheet" role="alertdialog" aria-modal="true" aria-labelledby="deldbx-title" aria-describedby="deldbx-desc" data-testid="deldbx-confirm"
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="sheet-card deldbx-card">
        <div className="settings-head">
          <h2 id="deldbx-title"><span aria-hidden="true">🗑️ </span>{one ? 'Delete this photo from Dropbox?' : `Delete ${n} photos from Dropbox?`}</h2>
          <button className="btn icon" aria-label="Close" onClick={onCancel}>✕</button>
        </div>
        <ul className="deldbx-files" data-testid="deldbx-files">
          {shown.map((p) => (
            <li key={p.id}>
              <Mini id={p.id} />
              <span><b>{p.name}</b><small className="muted">{p.dropbox?.path}</small></span>
            </li>
          ))}
          {n > shown.length && <li className="muted small">…and {n - shown.length} more</li>}
        </ul>
        <div id="deldbx-desc" className="deldbx-body">
          <p>{one ? 'The file will be deleted from your Dropbox' : 'The files will be deleted from your Dropbox'} — not just removed from Photo Tagger. Dropbox moves {one ? 'it' : 'them'} to its <b>deleted files</b>, where you can restore {one ? 'it' : 'them'} from <b>dropbox.com</b> for a limited time (<b>30 days on most plans</b>). After that {one ? 'it is' : 'they are'} gone for good.</p>
          <p>{one ? 'Its' : 'Their'} Photo Tagger tags and face names are removed too. Copies on other devices or shared links that point to {one ? 'this file' : 'these files'} stop working.</p>
          {skipped > 0 && <p className="muted small" data-testid="deldbx-skipped">{skipped} selected {skipped === 1 ? 'photo is' : 'photos are'} not from Dropbox and {skipped === 1 ? 'is' : 'are'} left alone.</p>}
        </div>
        <div className="row wrap deldbx-btns">
          <button type="button" ref={cancelRef} className="btn primary" data-testid="deldbx-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn danger-solid" data-testid="deldbx-ok" onClick={onConfirm}>Delete from Dropbox</button>
        </div>
      </div>
    </div>
  )
}
