import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Mode } from '../../../src/shared/events';
import { ModeSelect, nextMode } from './ModeSelect';

interface Props {
  running: boolean;
  mode: Mode;
  modesSupported: boolean;
  disabled?: boolean;
  focusRequest: number;
  onModeChange(mode: Mode): void;
  onSend(text: string): void;
  onStop(): void;
}

const PLACEHOLDER: Record<Mode, string> = {
  agent: 'Tell the agent what to do… (Enter to send)',
  ask: 'Ask a question — nothing will be changed… (Enter to send)',
  plan: 'Describe what to plan — nothing will be changed… (Enter to send)',
};

export function Composer({ running, mode, modesSupported, disabled, focusRequest, onModeChange, onSend, onStop }: Props) {
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
      onModeChange(nextMode(mode, modesSupported));
    }
  };

  return (
    <div className={`composer mode-${mode}`}>
      <textarea
        ref={ref}
        value={text}
        rows={1}
        placeholder={running ? 'Running… (Esc to stop)' : PLACEHOLDER[mode]}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Message"
      />
      <div className="composer-bar">
        <ModeSelect mode={mode} modesSupported={modesSupported} onChange={onModeChange} />
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
