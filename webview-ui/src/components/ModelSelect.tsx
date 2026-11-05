import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelOption } from '../../../src/shared/protocol';

interface Props {
  models: ModelOption[];
  value?: string;
  openRequest: number;
  onChange(model: string | undefined): void;
  onRefresh(): void;
}

/** Filterable model picker: CLI models, "Default", and a free-text custom id (PLAN.md §5.3). */
export function ModelSelect({ models, value, openRequest, onChange, onRefresh }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (open) {
      setFilter('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const options = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list: { id?: string; label: string; hint?: string }[] = [];
    const def = models.find((m) => m.isDefault);
    if (!f || 'default'.includes(f)) list.push({ id: undefined, label: 'Default', hint: def ? def.label : 'CLI default' });
    const matched = models.filter((m) => !f || m.id.toLowerCase().includes(f) || m.label.toLowerCase().includes(f));
    for (const m of matched.slice(0, 200)) list.push({ id: m.id, label: m.label, hint: m.id });
    if (f && !models.some((m) => m.id.toLowerCase() === f)) list.push({ id: filter.trim(), label: `Use "${filter.trim()}"`, hint: 'custom model id' });
    return list;
  }, [models, filter]);

  const current = value ? (models.find((m) => m.id === value)?.label ?? value) : 'Default model';

  const pick = (i: number) => {
    const o = options[i];
    if (!o) return;
    onChange(o.id);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="model-select" ref={rootRef}>
      <button className="model-button" onClick={() => setOpen(!open)} title={value ? `Model: ${value}` : 'Model: CLI default'} aria-haspopup="listbox" aria-expanded={open}>
        <span className="model-label">{current}</span> <span className="chevron">▾</span>
      </button>
      {open && (
        <div className="popup model-popup" role="listbox" onKeyDown={onKey}>
          <div className="popup-search">
            <input
              ref={inputRef}
              value={filter}
              placeholder={models.length ? `Filter ${models.length} models…` : 'Type a model id…'}
              onChange={(e) => {
                setFilter(e.target.value);
                setActive(0);
              }}
              aria-label="Filter models"
            />
            <button className="icon-btn small" title="Reload model list" onClick={onRefresh}>
              ↻
            </button>
          </div>
          <div className="popup-list">
            {options.map((o, i) => (
              <div
                key={`${o.id ?? '__default'}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`popup-item${i === active ? ' active' : ''}${o.id === value ? ' current' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(i);
                }}
              >
                <span>{o.label}</span>
                {o.hint && <span className="popup-hint">{o.hint}</span>}
              </div>
            ))}
            {!options.length && <div className="popup-empty">No models match.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
