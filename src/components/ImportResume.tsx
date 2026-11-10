import { useEffect, useState } from 'react'
import { runRecord, setRunRecord, useLibrary, type FolderProgress } from '../store'

/** "Import of /Photos/2019 stopped at 1,200 of 2,000. Continue?" after an import was interrupted (app closed mid-run). */
export function ImportResume() {
  const lib = useLibrary()
  const [rec] = useState(() => runRecord())
  const [p, setP] = useState<FolderProgress | null>(null)
  const [gone, setGone] = useState(false)
  const busy = !!lib.job
  useEffect(() => {
    if (!rec || gone || !lib.dropbox.connected || busy) return
    let off = false
    // give the Dropbox library a moment to load its sidecars so the count is right
    const t = setTimeout(() => {
      lib.dropboxFolderProgress(rec.path, rec.recursive).then((x) => {
        if (off) return
        if (x.remaining <= 0) { setRunRecord(null); setGone(true) } else setP(x)
      }).catch(() => {})
    }, 800)
    return () => { off = true; clearTimeout(t) }
  }, [rec, gone, lib.dropbox.connected, busy, lib.photos.length, lib.dropboxFolderProgress])
  if (!rec || gone || !p || busy) return null
  const n = (x: number) => x.toLocaleString('en-US')
  return (
    <div className="banner import-resume" role="status" data-testid="import-resume">
      <span>Import of <b>{rec.path || '/'}</b>{rec.recursive ? ' (with subfolders)' : ''} stopped at {n(p.inLibrary)} of {n(p.total)}. Continue?</span>
      <button className="btn small primary" data-testid="import-resume-continue" onClick={() => { setGone(true); void lib.addAllRemainingDropbox(rec.path, rec.recursive) }}>Continue ({n(p.remaining)} remaining)</button>
      <button className="btn small" data-testid="import-resume-dismiss" onClick={() => { setRunRecord(null); setGone(true) }}>Dismiss</button>
    </div>
  )
}
