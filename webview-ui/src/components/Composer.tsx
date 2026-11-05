import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Mode } from '../../../src/shared/events';
import type { ContextChip, ModelOption } from '../../../src/shared/protocol';
import { ArrowUpIcon, BranchIcon, FileIcon, PlusIcon, SlashIcon, StopIcon, WarnIcon } from '../sessions/icons';
import { useStore } from '../state/store';
import { send } from '../vscode';
import { ContextChips } from './ContextChips';
import { ModelSelect } from './ModelSelect';
import { MODES, ModeSelect, nextMode } from './ModeSelect';
import { OptionRow, Popover } from './Popover';

interface Props {
  tabId?: string;
  chips: ContextChip[];
  running: boolean;
  mode: Mode;
  model?: string;
  models: ModelOption[];
  modesSupported: boolean;
  /** CLI supports -w; undefined hides the toggle. */
  worktreeSupported?: boolean;
  worktree?: boolean;
  /** Last message sent in this tab, for ArrowUp recall. */
  lastSent?: string;
  disabled?: boolean;
  focusRequest: number;
  onModeChange(mode: Mode): void;
  onModelChange(model: string | undefined): void;
  onSend(text: string, chipIds: string[]): void;
  onStop(): void;
}

const PLACEHOLDER: Record<Mode, string> = {
  agent: 'Ask Cursor to build, fix or explain anything',
  ask: 'Ask a question. Nothing will be changed',
  plan: 'Describe what to plan. Nothing will be changed',
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
  { name: 'history', hint: 'Show past sessions' },
  { name: 'help', hint: 'Keyboard shortcuts and tips' },
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
  const [attachOpen, setAttachOpen] = useState(false);
  const closeAttach = useCallback(() => setAttachOpen(false), []);
  const openHistory = useStore((s) => s.openHistory);
  const openHelp = useStore((s) => s.openHelp);
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
        openHistory();
        clear();
        return true;
      case 'help':
        openHelp();
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
    } else if (e.key === 'ArrowUp' && !text && props.lastSent) {
      // Recall the last message into an empty composer (like a shell).
      e.preventDefault();
      setText(props.lastSent);
    } else if (e.key === 'Backspace' && !text && chips.length && tabId) {
      // Backspace in an empty composer removes the last chip.
      e.preventDefault();
      send({ type: 'chip/remove', tabId, chipId: chips[chips.length - 1]!.id });
    }
  };

  /** Insert a trigger character at the caret and open its popup (the + and / buttons). */
  const insertTrigger = (ch: '@' | '/') => {
    const el = ref.current;
    if (ch === '/') {
      setText('/');
      setPopup({ kind: 'slash', query: '' });
      setActive(0);
      setTimeout(() => {
        el?.focus();
        el?.setSelectionRange(1, 1);
      }, 0);
      return;
    }
    const caret = el?.selectionStart ?? text.length;
    const pre = text.slice(0, caret);
    const ins = pre && !/\s$/.test(pre) ? ' @' : '@';
    const next = pre + ins + text.slice(caret);
    setText(next);
    detectPopup(next, caret + ins.length);
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(caret + ins.length, caret + ins.length);
    }, 0);
  };

  const canSend = !!text.trim() && !disabled;

  return (
    <div className="composer">
      {popup && (
        <div className="popover above align-stretch composer-popup" role="listbox">
          <div className="option-list">
            {popup.kind === 'slash' &&
              slashOptions.map((c, i) => (
                <OptionRow
                  key={c.name}
                  label={
                    <span className="mono">
                      /{c.name}
                      {c.args ? <span className="muted"> {c.args}</span> : null}
                    </span>
                  }
                  trailing={<span className="option-hint">{c.hint}</span>}
                  active={i === active}
                  onHover={() => setActive(i)}
                  onPick={() => pickSlash(i)}
                />
              ))}
            {popup.kind === 'mention' &&
              mentionOptions.map((m, i) => (
                <OptionRow
                  key={m.path}
                  icon={<FileIcon />}
                  label={
                    <>
                      {m.path.split('/').pop()}
                      {m.isFolder ? '/' : ''}
                    </>
                  }
                  trailing={<span className="option-hint">{m.path}</span>}
                  active={i === active}
                  onHover={() => setActive(i)}
                  onPick={() => pickMention(i)}
                />
              ))}
            {optionCount === 0 && (
              <div className="option-empty">{popup.kind === 'mention' ? (popup.query ? 'No matching files.' : 'Searching…') : 'No such command.'}</div>
            )}
          </div>
        </div>
      )}
      <div
        className={`composer-box${disabled ? ' disabled' : ''}`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setTimeout(() => ref.current?.focus(), 0);
        }}
      >
        <ContextChips chips={chips} tabId={tabId} />
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={running ? 'Working… press Esc to stop' : PLACEHOLDER[mode]}
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
          <div className="attach-menu">
            <button className="icon-btn" title="Add context" aria-label="Add context" aria-expanded={attachOpen} onClick={() => setAttachOpen(!attachOpen)}>
              <PlusIcon />
            </button>
            <Popover open={attachOpen} onClose={closeAttach} placement="above" className="attach-popover" label="Add context">
              <div className="option-list" role="listbox">
                <OptionRow
                  icon={<FileIcon />}
                  label="Attach file or folder"
                  description="Same as typing @"
                  onPick={() => {
                    setAttachOpen(false);
                    insertTrigger('@');
                  }}
                />
                <OptionRow
                  icon={<span className="glyph">⌶</span>}
                  label="Add editor selection"
                  description="Ctrl+L in the editor"
                  onPick={() => {
                    setAttachOpen(false);
                    send({ type: 'context/add', what: 'selection' });
                  }}
                />
                <OptionRow
                  icon={<WarnIcon />}
                  label="Add problems"
                  description="Errors and warnings in the current file"
                  onPick={() => {
                    setAttachOpen(false);
                    send({ type: 'context/add', what: 'problems' });
                  }}
                />
                {props.worktreeSupported && tabId && (
                  <OptionRow
                    icon={<BranchIcon />}
                    label="Run in a git worktree"
                    description={running ? 'Can’t change while running' : 'Your working tree stays untouched'}
                    current={!!props.worktree}
                    disabled={running}
                    onPick={() => {
                      setAttachOpen(false);
                      send({ type: 'tab/setWorktree', tabId, enabled: !props.worktree });
                    }}
                  />
                )}
              </div>
            </Popover>
          </div>
          <button className="icon-btn" title="Commands" aria-label="Commands" onClick={() => insertTrigger('/')}>
            <SlashIcon />
          </button>
          <ModelSelect
            models={models}
            value={model}
            openRequest={modelOpen}
            onChange={props.onModelChange}
            onRefresh={() => send({ type: 'models/refresh' })}
          />
          {props.worktree && (
            <span className="pill static" title="This session runs in its own git worktree">
              <BranchIcon /> worktree
            </span>
          )}
          <span className="spacer" />
          <ModeSelect mode={mode} modesSupported={modesSupported} onChange={props.onModeChange} />
          {running ? (
            <button className="send-btn stop" onClick={props.onStop} title="Stop (Esc)" aria-label="Stop">
              <StopIcon />
            </button>
          ) : (
            <button className={`send-btn${canSend ? ' ready' : ''}`} onClick={submit} disabled={!canSend} title="Send (Enter)" aria-label="Send">
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
