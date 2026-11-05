import type { Mode } from '../../../src/shared/events';

export const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'agent', label: 'Agent', hint: 'Edits files and runs commands automatically' },
  { id: 'ask', label: 'Ask', hint: 'Read-only: answers questions, changes nothing' },
  { id: 'plan', label: 'Plan', hint: 'Proposes a plan, makes no changes' },
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
  onChange(mode: Mode): void;
}

export function ModeSelect({ mode, modesSupported, onChange }: Props) {
  const current = MODES.find((m) => m.id === mode);
  return (
    <select
      className={`mode-select mode-${mode}`}
      value={mode}
      onChange={(e) => onChange(e.target.value as Mode)}
      title={`${current?.hint ?? ''} — Shift+Tab to cycle`}
      aria-label="Mode"
    >
      {MODES.map((m) => (
        <option key={m.id} value={m.id} disabled={!modesSupported && m.id !== 'agent'}>
          {m.label}
        </option>
      ))}
    </select>
  );
}
