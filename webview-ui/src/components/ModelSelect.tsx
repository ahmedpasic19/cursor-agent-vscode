import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelOption } from '../../../src/shared/protocol';
import {
  familyLabelFromVariantLabel,
  familyRepresentativeId,
  parseModelId,
  representativeIdForFamilyGroup,
} from '../modelId';
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
  /** True when row is "Use custom id" */
  custom?: boolean;
  /** Non-model row: "Show all models". */
  action?: 'showAll';
}

/** Cursor's own models, shown first and on their own, like the Cursor IDE picker. */
const CURSOR_MODEL_RE = /^(auto|composer)/i;

/**
 * The families worth offering without asking: one row each, best match first. The full catalog
 * (hundreds of ids) stays one click — or one keystroke — away.
 */
const FEATURED: RegExp[] = [
  /opus/i,
  /fable/i,
  /sonnet/i,
  /haiku/i,
  /gpt/i,
  /codex/i,
  /gemini/i,
  /grok/i,
];

/**
 * Claude Code–style model picker: a pill in the composer that opens a list of two-line rows
 * (name + description) with a check on the current model. Typing filters the list; a custom
 * id can be used as-is.
 */
export function ModelSelect({ models, value, openRequest, onChange, onRefresh }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    setFilter('');
    setActive(0);
    setShowAll(false);
    setTimeout(() => listRef.current?.focus(), 0);
  }, [open]);

  const idToLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of models) map.set(m.id, m.label);
    return map;
  }, [models]);

  const labelOf = useCallback(
    (id?: string) => {
      if (!id) return 'Default';
      const raw = idToLabel.get(id);
      if (raw) return familyLabelFromVariantLabel(raw);
      const p = parseModelId(id);
      if (!p.token) return id;
      const rep = familyRepresentativeId(models, p.family, p.fast);
      if (rep) {
        const lbl = idToLabel.get(rep);
        if (lbl) return familyLabelFromVariantLabel(lbl);
      }
      return id;
    },
    [idToLabel, models],
  );

  const familyCount = useMemo(() => {
    const keys = new Set<string>();
    for (const m of models) {
      const p = parseModelId(m.id);
      keys.add(`${p.family}\0${p.fast ? '1' : '0'}`);
    }
    return keys.size;
  }, [models]);

  const options = useMemo<Opt[]>(() => {
    const f = filter.trim().toLowerCase();
    const def = models.find((m) => m.isDefault);
    if (f) {
      const out: Opt[] = models
        .filter((m) => m.id.toLowerCase().includes(f) || m.label.toLowerCase().includes(f))
        .slice(0, 200)
        .map((m) => ({ id: m.id, label: m.label, description: modelDescription(m.id) }));
      if ('default'.includes(f)) out.unshift({ id: undefined, label: 'Default', description: def ? `CLI default: ${def.label}` : modelDescription(undefined) });
      if (!models.some((m) => m.id.toLowerCase() === f)) out.push({ id: filter.trim(), label: `Use “${filter.trim()}”`, description: 'Custom model id', custom: true });
      return out;
    }

    const seenIds = new Set<string>();
    const seenFamilyKeys = new Set<string>();
    const out: Opt[] = [{ id: undefined, label: 'Default', description: def ? `CLI default: ${def.label}` : modelDescription(undefined) }];

    const familyKeyOf = (id: string) => {
      const p = parseModelId(id);
      return `${p.family}\0${p.fast ? '1' : '0'}`;
    };

    const pushRecent = (id: string, section?: string) => {
      if (seenIds.has(id)) return;
      seenIds.add(id);
      seenFamilyKeys.add(familyKeyOf(id));
      out.push({ id, label: labelOf(id), description: modelDescription(id), section });
    };

    const recent = [value, ...recentModels()].filter((id): id is string => !!id);
    recent.forEach((id, i) => pushRecent(id, i === 0 ? 'Recent' : undefined));

    const byFamily = new Map<string, ModelOption[]>();
    for (const m of models) {
      const p = parseModelId(m.id);
      const key = `${p.family}\0${p.fast ? '1' : '0'}`;
      let arr = byFamily.get(key);
      if (!arr) {
        arr = [];
        byFamily.set(key, arr);
      }
      arr.push(m);
    }

    const pushFamily = (group: ModelOption[], section?: string) => {
      const key = familyKeyOf(group[0]!.id);
      if (seenFamilyKeys.has(key)) return false;
      seenFamilyKeys.add(key);
      const pickId = representativeIdForFamilyGroup(group);
      out.push({ id: pickId, label: labelOf(pickId), description: modelDescription(pickId), section });
      return true;
    };

    const groups = [...byFamily.values()].filter((g) => !parseModelId(g[0]!.id).fast);

    if (showAll) {
      let first = true;
      for (const group of byFamily.values()) {
        if (pushFamily(group, first ? 'All models' : undefined)) first = false;
      }
      return out;
    }

    // Short list, the way Cursor's own picker does it: its models, then a handful of the rest.
    let firstCursor = true;
    for (const group of groups) {
      if (!CURSOR_MODEL_RE.test(group[0]!.id)) continue;
      if (pushFamily(group, firstCursor ? 'Cursor Models' : undefined)) firstCursor = false;
    }

    let firstOther = true;
    for (const re of FEATURED) {
      const group = groups.find((g) => re.test(g[0]!.id));
      if (!group) continue;
      if (pushFamily(group, firstOther ? 'Other Models' : undefined)) firstOther = false;
    }

    out.push({ label: 'Show all models', description: `${familyCount} families · or type to filter`, action: 'showAll' });
    return out;
  }, [models, filter, value, labelOf, showAll, familyCount]);

  const pick = (o?: Opt) => {
    if (!o) return;
    if (o.action === 'showAll') {
      setShowAll(true);
      setActive(0);
      return;
    }
    const nextId = o.id;
    rememberModel(nextId);
    onChange(nextId);
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

  const footerHint =
    models.length && familyCount
      ? `${models.length} models · ${familyCount} families · type to filter`
      : models.length
        ? `${models.length} models · type to filter`
        : 'Type a model id';

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
            <span className="muted">{footerHint}</span>
            <button className="ghost-btn" title="Reload the model list from the CLI" onClick={onRefresh}>
              <RefreshIcon /> Refresh
            </button>
          </>
        }
      >
        <div className="option-list" role="listbox" tabIndex={0} ref={listRef} onKeyDown={onKey} aria-label="Models">
          {options.map((o, i) => (
            <div key={`${o.action ?? o.id ?? '__default'}-${i}`}>
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
