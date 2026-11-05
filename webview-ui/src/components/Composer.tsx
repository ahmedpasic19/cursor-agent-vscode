import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Mode } from '../../../src/shared/events';

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'agent', label: 'Agent', hint: 'Edits files and runs commands' },
  { id: 'ask', label: 'Ask', hint: 'Read-only questions' },
  { id: 'plan', label: 'Plan', hint: 'Proposes a plan, no changes' },
];

interface Props {
  running: boolean;
  mode: Mode;
  disabled?: boolean;
  focusRequest: number;
  onModeChange(mode: Mode): void;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer({ running, mode, disabled, focusRequest, onModeChange, onSend, onStop }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 300)}px`;
    el.style.overflowY = el.scrollHeight > 300 ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => {
    ref.current?.focus();
  }, [focusRequest]);

  const submit = () => {
    const t = text.trim();
    if (!t || running || disabled) return;
    onSend(t);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && running) {
      e.preventDefault();
      onStop();
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const i = MODES.findIndex((m) => m.id === mode);
      onModeChange(MODES[(i + 1) % MODES.length]!.id);
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        placeholder={running ? 'Running… (Esc to stop)' : 'Ask Cursor Agent… (Enter to send, Shift+Enter for newline)'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Message"
      />
      <div className="composer-bar">
        <select
          className="mode-select"
          value={mode}
          onChange={(e) => onModeChange(e.target.value as Mode)}
          title="Mode (Shift+Tab to cycle)"
          aria-label="Mode"
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id} title={m.hint}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {running ? (
          <button className="btn stop" onClick={onStop} title="Stop (Esc)">
            Stop
          </button>
        ) : (
          <button className="btn primary" onClick={submit} disabled={!text.trim() || disabled} title="Send (Enter)">
            Send
          </button>
        )}
      </div>
    </div>
  );
}
