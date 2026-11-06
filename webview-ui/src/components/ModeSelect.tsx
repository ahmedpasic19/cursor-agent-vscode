import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Mode } from '../../../src/shared/events';
import type { ModelOption } from '../../../src/shared/protocol';
import { ChatIcon, CodeIcon, PlanIcon } from '../sessions/icons';
import { EffortMeter } from './EffortMeter';
import { OptionRow, Popover } from './Popover';

export const MODES: { id: Mode; label: string; hint: string; icon: () => ReactNode }[] = [
  { id: 'agent', label: 'Agent', hint: 'Edits files and runs commands automatically', icon: CodeIcon },
  { id: 'ask', label: 'Ask', hint: 'Read-only: answers questions, changes nothing', icon: ChatIcon },
  { id: 'plan', label: 'Plan', hint: 'Explores the code and presents a plan before editing', icon: PlanIcon },
];

export function nextMode(mode: Mode, modesSupported: boolean): Mode {
  if (!modesSupported) return 'agent';
  const i = MODES.findIndex((m) => m.id === mode);
  return MODES[(i + 1) % MODES.length]!.id;
}

interface Props {
  mode: Mode;
  /** False when the CLI has no --mode flag: only Agent is available. */
  modesSupported: boolean;
  models: ModelOption[];
  model?: string;
  onChange(mode: Mode): void;
  onModelChange(model: string | undefined): void;
}

/** Claude Code–style mode button + popover ("Modes · ⇧+tab to switch"). */
export function ModeSelect({ mode, modesSupported, models, model, onChange, onModelChange }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]!;
  const Icon = current.icon;
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, MODES.findIndex((m) => m.id === mode)));
    setTimeout(() => listRef.current?.focus(), 0);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const enabled = (m: Mode) => modesSupported || m === 'agent';
  const pick = (m: Mode) => {
    if (!enabled(m)) return;
    onChange(m);
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const meter = effortRef.current;
      if (meter && document.activeElement === listRef.current) {
        e.preventDefault();
        e.stopPropagation();
        meter.focus();
        meter.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true }));
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % MODES.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + MODES.length) % MODES.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(MODES[active]!.id);
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      onChange(nextMode(mode, modesSupported));
    }
  };

  const onEffortChange = useCallback(
    (mid: string) => {
      onModelChange(mid);
    },
    [onModelChange],
  );

  return (
    <div className="mode-select">
      <button
        className={`ghost-btn mode-button${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        title={`${current.hint} (Shift+Tab to switch)`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Mode: ${current.label}`}
      >
        <Icon />
        <span>{current.label}</span>
      </button>
      <Popover
        open={open}
        onClose={close}
        placement="above"
        align="right"
        className="mode-popover"
        label="Modes"
        header={
          <>
            <span>Modes</span>
            <span className="spacer" />
            <span className="keys">
              <kbd>⇧</kbd> + <kbd>tab</kbd> to switch
            </span>
          </>
        }
        footer={<EffortMeter ref={effortRef} models={models} model={model} onChange={onEffortChange} />}
      >
        <div className="option-list" role="listbox" tabIndex={0} ref={listRef} onKeyDown={onKey} aria-label="Modes">
          {MODES.map((m, i) => {
            const MIcon = m.icon;
            return (
              <OptionRow
                key={m.id}
                icon={<MIcon />}
                label={m.label}
                description={enabled(m.id) ? m.hint : 'Needs a newer cursor-agent'}
                current={m.id === mode}
                active={i === active}
                disabled={!enabled(m.id)}
                onHover={() => setActive(i)}
                onPick={() => pick(m.id)}
              />
            );
          })}
        </div>
      </Popover>
    </div>
  );
}
