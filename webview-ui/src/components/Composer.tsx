import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Mode } from '../../../src/shared/events';
import type { ContextChip, ModelOption } from '../../../src/shared/protocol';
import { useStore } from '../state/store';
import { send } from '../vscode';
import { ContextChips } from './ContextChips';
import { ModelSelect } from './ModelSelect';
import { MODES, ModeSelect, nextMode } from './ModeSelect';

interface Props {
  tabId?: string;
  chips: ContextChip[];
  running: boolean;
  mode: Mode;
  model?: string;
  models: ModelOption[];
  modesSupported: boolean;
  disabled?: boolean;
  focusRequest: number;
  onModeChange(mode: Mode): void;
  onModelChange(model: string | undefined): void;
  onSend(text: string, chipIds: string[]): void;
  onStop(): void;
}

const PLACEHOLDER: Record<Mode, string> = {
  agent: 'Tell the agent what to do… @ to add files, / for commands',
  ask: 'Ask a question — nothing will be changed… @ to add files',
  plan: 'Describe what to plan — nothing will be changed… @ to add files',
};

interface SlashCommand {
  name: string;
  args?: string;
  hint: string;
}
const SLASH: SlashCommand[] = [
  { name: 'new', hint: 'Start a new chat' },
  { name: 'clear', hint: 'Start a new session in this tab' },
  { name: 'model', args: '[id]', hint: 'Pick or set the model' },
  { name: 'mode', args: '[agent|ask|plan]', hint: 'Set or cycle the mode' },
  { name: 'history', hint: 'Search past chats' },
];

type Popup =
  | { kind: 'mention'; start: number; query: string }
  | { kind: 'slash'; query: string }
  | undefined;

let mentionRequest = 0;
/** Unsent text per tab (the composer remounts on tab switch). */
const drafts = new Map<string, string>();

export function Composer(props: Props) {
  const { tabId, chips, running, mode, model, models, modesSupported, disabled, focusRequest } = props;
  const [text, setTextState] = useState(() => (tabId ? (drafts.get(tabId) ?? '') : ''));
  const setText = (v: string) => {
    setTextState(v);
    if (tabId) drafts.set(tabId, v);
  };
  const [popup, setPopup] = useState<Popup>();
  const [active, setActive] = useState(0);
  const [modelOpen, setModelOpen] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mention = useStore((s) => s.mention);
  const showNotice = useStore((s) => s.showNotice);

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

  // ---------- popups ----------

  const detectPopup = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (m) {
      const query = m[2]!;
      const start = caret - query.length - 1;
      setPopup({ kind: 'mention', start, query });
      setActive(0);
      if (tabId) send({ type: 'mention/search', tabId, query, requestId: ++mentionRequest });
      return;
    }
    const s = /^\/(\w*)$/.exec(before);
    if (s && !value.includes('\n')) {
      setPopup({ kind: 'slash', query: s[1]! });
      setActive(0);
      return;
    }
    setPopup(undefined);
  };

  const slashOptions = useMemo(
    () => (popup?.kind === 'slash' ? SLASH.filter((c) => c.name.startsWith(popup.query.toLowerCase())) : []),
    [popup],
  );
  const mentionOptions = popup?.kind === 'mention' && mention.requestId === mentionRequest ? mention.items : [];
  const optionCount = popup?.kind === 'slash' ? slashOptions.length : mentionOptions.length;

  const pickMention = (i: number) => {
    const item = mentionOptions[i];
    if (!item || popup?.kind !== 'mention' || !tabId) return;
    send({ type: 'mention/pick', tabId, path: item.path, isFolder: item.isFolder });
    const caret = ref.current?.selectionStart ?? text.length;
    const next = text.slice(0, popup.start) + text.slice(caret);
    setText(next.replace(/ {2,}/g, ' '));
    setPopup(undefined);
    setTimeout(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(popup.start, popup.start);
    }, 0);
  };

  const pickSlash = (i: number) => {
    const c = slashOptions[i];
    if (!c) return;
    if (c.args) {
      setText(`/${c.name} `);
      setPopup(undefined);
      ref.current?.focus();
    } else {
      runSlash(`/${c.name}`);
    }
  };

  /** Returns true if `t` was a slash command (handled, not sent). */
  const runSlash = (t: string): boolean => {
    const m = /^\/(\w+)(?:\s+(.*))?$/.exec(t.trim());
    if (!m) return false;
    const [, name, arg] = m;
    const clear = () => {
      setText('');
      setPopup(undefined);
    };
    switch (name) {
      case 'new':
        send({ type: 'tab/new' });
        clear();
        return true;
      case 'clear':
        if (tabId && !running) send({ type: 'tab/clear', tabId });
        clear();
        return true;
      case 'model':
        if (arg?.trim()) props.onModelChange(arg.trim() === 'default' ? undefined : arg.trim());
        else setModelOpen((n) => n + 1);
        clear();
        return true;
      case 'mode': {
        const want = arg?.trim().toLowerCase();
        const found = MODES.find((x) => x.id === want);
        if (want && !found) showNotice('warning', `Unknown mode "${want}". Use agent, ask or plan.`);
        else props.onModeChange(found ? found.id : nextMode(mode, modesSupported));
        clear();
        return true;
      }
      case 'history':
        send({ type: 'history/request' });
        useStore.getState().setHistoryOpen(true);
        clear();
        return true;
      default:
        return false;
    }
  };

  // ---------- send / keys ----------

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    if (t.startsWith('/') && runSlash(t)) return;
    if (running) return;
    props.onSend(t, chips.map((c) => c.id));
    setText('');
    setPopup(undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (popup && optionCount > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % optionCount);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + optionCount) % optionCount);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        if (popup.kind === 'mention') pickMention(active);
        else pickSlash(active);
        return;
      }
    }
    if (popup && e.key === 'Escape') {
      e.preventDefault();
      setPopup(undefined);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && running) {
      e.preventDefault();
      props.onStop();
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      props.onModeChange(nextMode(mode, modesSupported));
    } else if (e.key === 'Backspace' && !text && chips.length && tabId) {
      // Backspace in an empty composer removes the last chip.
      e.preventDefault();
      send({ type: 'chip/remove', tabId, chipId: chips[chips.length - 1]!.id });
    }
  };

  return (
    <div className={`composer mode-${mode}`}>
      {popup && (
        <div className="popup composer-popup" role="listbox">
          {popup.kind === 'slash' &&
            slashOptions.map((c, i) => (
              <div
                key={c.name}
                role="option"
                aria-selected={i === active}
                className={`popup-item${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSlash(i);
                }}
              >
                <span className="mono">
                  /{c.name}
                  {c.args ? ` ${c.args}` : ''}
                </span>
                <span className="popup-hint">{c.hint}</span>
              </div>
            ))}
          {popup.kind === 'mention' &&
            mentionOptions.map((m, i) => (
              <div
                key={m.path}
                role="option"
                aria-selected={i === active}
                className={`popup-item${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(i);
                }}
              >
                <span>
                  {m.isFolder ? '📁 ' : ''}
                  {m.path.split('/').pop()}
                  {m.isFolder ? '/' : ''}
                </span>
                <span className="popup-hint">{m.path}</span>
              </div>
            ))}
          {optionCount === 0 && (
            <div className="popup-empty">{popup.kind === 'mention' ? (popup.query ? 'No matching files.' : 'Searching…') : 'No such command.'}</div>
          )}
        </div>
      )}
      <ContextChips chips={chips} tabId={tabId} />
      <textarea
        ref={ref}
        value={text}
        rows={1}
        placeholder={running ? 'Running… (Esc to stop)' : PLACEHOLDER[mode]}
        onChange={(e) => {
          setText(e.target.value);
          detectPopup(e.target.value, e.target.selectionStart);
        }}
        onClick={(e) => detectPopup(text, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setPopup(undefined), 150)}
        onKeyDown={onKeyDown}
        aria-label="Message"
      />
      <div className="composer-bar">
        <ModeSelect mode={mode} modesSupported={modesSupported} onChange={props.onModeChange} />
        <ModelSelect
          models={models}
          value={model}
          openRequest={modelOpen}
          onChange={props.onModelChange}
          onRefresh={() => send({ type: 'models/refresh' })}
        />
        <span className="spacer" />
        {running ? (
          <button className="btn stop" onClick={props.onStop} title="Stop (Esc)">
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
