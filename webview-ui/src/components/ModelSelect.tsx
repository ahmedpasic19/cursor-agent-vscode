import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelOption } from '../../../src/shared/protocol';
import { modelDescription, recentModels, rememberModel } from '../modelInfo';
import { RefreshIcon } from '../sessions/icons';
import { OptionRow, Popover } from './Popover';

interface Props {
  models: ModelOption[];
  value?: string;
  openRequest: number;
  onChange(model: string | undefined): void;
  onRefresh(): void;
}

interface Opt {
  id?: string;
  label: string;
  description?: string;
  section?: string;
}

/**
 * Claude Code–style model picker: a pill in the composer that opens a list of two-line rows
 * (name + description) with a check on the current model. Typing filters the list; a custom
 * id can be used as-is.
 */
export function ModelSelect({ models, value, openRequest, onChange, onRefresh }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    setFilter('');
    setActive(0);
    setTimeout(() => listRef.current?.focus(), 0);
  }, [open]);

  const labelOf = useCallback((id?: string) => (id ? (models.find((m) => m.id === id)?.label ?? id) : 'Default'), [models]);

  const options = useMemo<Opt[]>(() => {
    const f = filter.trim().toLowerCase();
    const def = models.find((m) => m.isDefault);
    if (f) {
      const out: Opt[] = models
        .filter((m) => m.id.toLowerCase().includes(f) || m.label.toLowerCase().includes(f))
        .slice(0, 200)
        .map((m) => ({ id: m.id, label: m.label, description: modelDescription(m.id) }));
      if ('default'.includes(f)) out.unshift({ id: undefined, label: 'Default', description: def ? `CLI default: ${def.label}` : modelDescription(undefined) });
      if (!models.some((m) => m.id.toLowerCase() === f)) out.push({ id: filter.trim(), label: `Use “${filter.trim()}”`, description: 'Custom model id' });
      return out;
    }
    const out: Opt[] = [{ id: undefined, label: 'Default', description: def ? `CLI default: ${def.label}` : modelDescription(undefined) }];
    const seen = new Set<string>();
    const recent = [value, ...recentModels()].filter((id): id is string => !!id && !seen.has(id) && !!seen.add(id));
    recent.forEach((id, i) => out.push({ id, label: labelOf(id), description: modelDescription(id), section: i === 0 ? 'Recent' : undefined }));
    models
      .filter((m) => !seen.has(m.id))
      .forEach((m, i) => out.push({ id: m.id, label: m.label, description: modelDescription(m.id), section: i === 0 ? 'All models' : undefined }));
    return out;
  }, [models, filter, value, labelOf]);

  const pick = (o?: Opt) => {
    if (!o) return;
    rememberModel(o.id);
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
      pick(options[active]);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      setFilter((f) => f.slice(0, -1));
      setActive(0);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setFilter((f) => f + e.key);
      setActive(0);
    }
  };

  const currentDesc = modelDescription(value);
  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="model-select">
      <button
        className={`pill model-pill${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        title={value ? `Model: ${value}` : 'Model: CLI default'}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-label">{value ? labelOf(value) : 'Default model'}</span>
      </button>
      <Popover
        open={open}
        onClose={close}
        placement="above"
        className="model-popover"
        label="Models"
        header={
          filter ? (
            <span>
              Filter: <span className="filter-text">{filter}</span>
              <span className="caret" />
            </span>
          ) : (
            <span className="ellipsis">
              {labelOf(value)}
              {currentDesc ? ` · ${currentDesc}` : ''}
            </span>
          )
        }
        footer={
          <>
            <span className="muted">{models.length ? `${models.length} models · type to filter` : 'Type a model id'}</span>
            <button className="ghost-btn" title="Reload the model list from the CLI" onClick={onRefresh}>
              <RefreshIcon /> Refresh
            </button>
          </>
        }
      >
        <div className="option-list" role="listbox" tabIndex={0} ref={listRef} onKeyDown={onKey} aria-label="Models">
          {options.map((o, i) => (
            <div key={`${o.id ?? '__default'}-${i}`}>
              {o.section && <div className="option-section">{o.section}</div>}
              <OptionRow
                label={o.label}
                description={o.description}
                current={o.id === value}
                active={i === active}
                onHover={() => setActive(i)}
                onPick={() => pick(o)}
              />
            </div>
          ))}
          {!options.length && <div className="option-empty">No models match.</div>}
        </div>
      </Popover>
    </div>
  );
}
