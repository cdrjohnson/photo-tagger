import { useId, useMemo, useRef, useState } from 'react'
import { matchTags, resolveTagName } from '../tags'

/**
 * Add-tag box with its own suggestion list (every existing tag, filtered as you type — no hidden tail).
 * Enter / comma / Add commit the typed text; a close spelling of an existing tag reuses that tag.
 */
export function TagInput({ suggestions, onAdd, placeholder = 'Add a tag…', testId = 'tag-input', autoFocus }: {
  suggestions: string[]
  onAdd: (names: string[]) => void
  placeholder?: string
  testId?: string
  autoFocus?: boolean
}) {
  const [v, setV] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  // only the part after the last comma is being typed
  const current = v.slice(v.lastIndexOf(',') + 1)
  const matches = useMemo(() => matchTags(current, suggestions, 300), [current, suggestions])
  const commitNames = (names: string[], exact = false) => {
    const out = names.map((s) => s.trim()).filter(Boolean).map((s) => (exact ? s : resolveTagName(s, suggestions))).filter(Boolean)
    if (out.length) onAdd([...new Set(out)])
  }
  const commit = () => { commitNames(v.split(',')); setV(''); setActive(-1); setOpen(false) }
  const pick = (s: string) => {
    const before = v.slice(0, v.lastIndexOf(',') + 1).split(',')
    commitNames(before, false); commitNames([s], true)
    setV(''); setActive(-1); setOpen(false)
  }
  const move = (d: number) => {
    if (!matches.length) return
    setOpen(true)
    setActive((a) => { const n = (a + d + matches.length) % matches.length; listRef.current?.children[n]?.scrollIntoView({ block: 'nearest' }); return n })
  }
  return (
    <div className="tag-input" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }}>
      <div className="tag-input-box">
        <input
          data-testid={testId}
          value={v}
          autoFocus={autoFocus}
          placeholder={placeholder}
          enterKeyHint="done"
          autoCapitalize="none"
          autoComplete="off"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          // opens on click, ↓ or typing (not on autofocus, so it doesn't cover the dialog behind it)
          onClick={() => setOpen(true)}
          onChange={(e) => { setV(e.target.value); setActive(-1); setOpen(true) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
            else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setActive(-1) }
            else if (e.key === 'Enter') { e.preventDefault(); if (open && active >= 0 && matches[active]) pick(matches[active]); else commit() }
            else if (e.key === ',') { e.preventDefault(); commit() }
          }}
        />
        {open && matches.length > 0 && (
          <ul id={listId} ref={listRef} className="tag-suggest" role="listbox" data-testid={`${testId}-suggestions`} aria-label="Existing tags">
            {matches.map((s, i) => (
              <li key={s} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} data-testid="tag-suggestion" data-tag={s}
                onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>{s}</li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className="btn" data-testid={`${testId}-add`} onClick={commit} disabled={!v.trim()}>Add</button>
    </div>
  )
}
