import { useId, useState } from 'react'

export function TagInput({ suggestions, onAdd, placeholder = 'Add a tag…', testId = 'tag-input', autoFocus }: {
  suggestions: string[]
  onAdd: (names: string[]) => void
  placeholder?: string
  testId?: string
  autoFocus?: boolean
}) {
  const [v, setV] = useState('')
  const listId = useId()
  const commit = () => {
    const names = v.split(',').map((s) => s.trim()).filter(Boolean)
    if (names.length) onAdd(names)
    setV('')
  }
  return (
    <div className="tag-input">
      <input
        data-testid={testId}
        value={v}
        autoFocus={autoFocus}
        list={listId}
        placeholder={placeholder}
        enterKeyHint="done"
        autoCapitalize="none"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() } }}
      />
      <datalist id={listId}>{suggestions.slice(0, 60).map((s) => <option key={s} value={s} />)}</datalist>
      <button type="button" className="btn" data-testid={`${testId}-add`} onClick={commit} disabled={!v.trim()}>Add</button>
    </div>
  )
}
