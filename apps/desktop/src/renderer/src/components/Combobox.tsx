import { useEffect, useRef, useState } from 'react'

// Free-text input + a custom suggestions dropdown. Unlike the native <datalist>
// (which floats in a detached browser layer and won't scroll with the panel),
// the dropdown here is absolutely positioned inside a relative wrapper, so it
// stays anchored to the field as the settings body scrolls. You can type any
// value OR pick a suggestion — there is no forced/hardcoded choice.
interface Props {
  id?: string
  value: string
  options: string[]
  onChange: (value: string) => void
  placeholder?: string
}

export function Combobox({ id, value, options, onChange, placeholder }: Props) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const q = value.trim().toLowerCase()
  const filtered = q ? options.filter(o => o.toLowerCase().includes(q)) : options

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClickOutside)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapperRef} className={`lselect ${open ? 'is-open' : ''}`}>
      <input
        id={id}
        type="text"
        className="lselect-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={e => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
      />
      {open && filtered.length > 0 && (
        <ul className="lselect-options" role="listbox">
          {filtered.map(opt => (
            <li
              key={opt}
              role="option"
              aria-selected={opt === value}
              className={`lselect-option ${opt === value ? 'is-selected' : ''}`}
              // onMouseDown (not onClick) so selection fires before the input blurs.
              onMouseDown={e => { e.preventDefault(); onChange(opt); setOpen(false) }}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
