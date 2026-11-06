import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { Mode } from '../../../src/shared/events';
import type { ContextChip, ModelOption } from '../../../src/shared/protocol';
import { ArrowUpIcon, BranchIcon, FileIcon, PlusIcon, SlashIcon, StopIcon, WarnIcon } from '../sessions/icons';
import { useStore } from '../state/store';
import { send } from '../vscode';
import { attachImages, IMAGE_TYPES, imageFiles, imageUris } from '../images';
import { chipIdsIn, chipToken, CHIP_TOKEN_RE } from '../../../src/shared/inlineChips';
import { ImageThumbs, openChip } from './ContextChips';
import { getCaret, render, serialize, setCaret } from './richInput';
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
  const textRef = useRef(text);
  const setText = (v: string) => {
    textRef.current = v;
    setTextState(v);
    if (tabId) drafts.set(tabId, v);
  };
  /** Last caret offset in `text` (kept while the webview is blurred, so new chips land there). */
  const caretRef = useRef<number | undefined>(undefined);
  /** Chips the input has already placed; a chip not in here is new and gets inserted at the caret. */
  const known = useRef(new Set<string>(chipIdsIn(text)));
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const [popup, setPopup] = useState<Popup>();
  const [active, setActive] = useState(0);
  const [modelOpen, setModelOpen] = useState(0);
  const [attachOpen, setAttachOpen] = useState(false);
  const closeAttach = useCallback(() => setAttachOpen(false), []);
  const openHistory = useStore((s) => s.openHistory);
  const openHelp = useStore((s) => s.openHelp);
  const ref = useRef<HTMLDivElement>(null);
  const mention = useStore((s) => s.mention);
  const showNotice = useStore((s) => s.showNotice);

  /** Set the value programmatically: state, DOM and (optionally) the caret. */
  const apply = (value: string, caret?: number) => {
    setText(value);
    const el = ref.current;
    if (!el) return;
    render(el, value, chipsRef.current);
    if (caret !== undefined) {
      caretRef.current = caret;
      if (document.activeElement === el) setCaret(el, caret);
    }
  };
  const trackCaret = () => {
    const el = ref.current;
    const c = el ? getCaret(el) : undefined;
    if (c !== undefined) caretRef.current = c;
  };

  // Keep inline chips in sync with the tab's chips: new ones go in at the caret, chips removed
  // elsewhere (e.g. after send) leave the text.
  useLayoutEffect(() => {
    const ids = new Set(chips.map((c) => c.id));
    let t = textRef.current;
    let caret = caretRef.current ?? t.length;
    for (const id of chipIdsIn(t)) {
      if (ids.has(id)) continue;
      const tok = chipToken(id);
      const at = t.indexOf(tok);
      t = t.replace(tok, '');
      if (at < caret) caret = Math.max(at, caret - tok.length);
    }
    // Images are not inline: they sit in a strip above the input.
    for (const c of chips) {
      if (c.kind === 'image' || known.current.has(c.id)) continue;
      known.current.add(c.id);
      caret = Math.min(caret, t.length);
      const pre = t.slice(0, caret);
      const post = t.slice(caret);
      const ins = (pre && !/\s$/.test(pre) ? ' ' : '') + chipToken(c.id) + (post.startsWith(' ') ? '' : ' ');
      t = pre + ins + post;
      caret += ins.length;
    }
    for (const id of [...known.current]) if (!ids.has(id)) known.current.delete(id);
    const el = ref.current;
    const keep = el && document.activeElement === el ? getCaret(el) : undefined;
    apply(t, t === textRef.current && keep !== undefined ? keep : caret);
  }, [chips]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    setCaret(el, caretRef.current ?? textRef.current.length);
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
    send({ type: 'mention/pick', tabId, path: item.path, isFolder: item.isFolder, root: item.root });
    const caret = (ref.current ? getCaret(ref.current) : undefined) ?? caretRef.current ?? text.length;
    // The chip arrives from the host a moment later and is inserted where the @query was.
    const next = text.slice(0, popup.start) + text.slice(caret);
    ref.current?.focus();
    apply(next, popup.start);
    setPopup(undefined);
  };

  const pickSlash = (i: number) => {
    const c = slashOptions[i];
    if (!c) return;
    if (c.args) {
      ref.current?.focus();
      apply(`/${c.name} `, c.name.length + 2);
      setPopup(undefined);
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
      apply('', 0);
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

  const hasImage = chips.some((c) => c.kind === 'image');
  const submit = () => {
    // An image alone is a valid message.
    const plain = text.replace(CHIP_TOKEN_RE, '').trim();
    // An image alone is a valid message; other chips alone are sent as their mentions.
    const t = plain
      ? text.trim()
      : hasImage
        ? `${text.trim()} Take a look at the attached image.`.trim()
        : chips.length
          ? text.trim()
          : '';
    if (!t || disabled) return;
    if (t.startsWith('/') && runSlash(t)) return;
    if (running) return;
    props.onSend(t, chips.map((c) => c.id));
    apply('', 0);
    setPopup(undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!e.shiftKey) return submit();
      // Shift+Enter: a plain newline (the browser's own would insert <div>s).
      const c = (ref.current ? getCaret(ref.current) : undefined) ?? text.length;
      apply(text.slice(0, c) + '\n' + text.slice(c), c + 1);
    } else if (e.key === 'Escape' && running) {
      e.preventDefault();
      props.onStop();
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      props.onModeChange(nextMode(mode, modesSupported));
    } else if (e.key === 'ArrowUp' && !text && props.lastSent) {
      // Recall the last message into an empty composer (like a shell).
      e.preventDefault();
      apply(props.lastSent, props.lastSent.length);
    }
  };

  /** Insert a trigger character at the caret and open its popup (the + and / buttons). */
  const insertTrigger = (ch: '@' | '/') => {
    ref.current?.focus();
    if (ch === '/') {
      apply('/', 1);
      setPopup({ kind: 'slash', query: '' });
      setActive(0);
      return;
    }
    const caret = Math.min(caretRef.current ?? text.length, text.length);
    const pre = text.slice(0, caret);
    const ins = pre && !/\s$/.test(pre) ? ' @' : '@';
    const next = pre + ins + text.slice(caret);
    apply(next, caret + ins.length);
    detectPopup(next, caret + ins.length);
  };

  const canSend = (!!text.trim() || hasImage) && !disabled;

  // ---------- images: paste, drop, picker ----------

  const fileInput = useRef<HTMLInputElement>(null);
  /** 'hint': a file drag without Shift (VS Code takes the drop); 'drop': Shift held, the panel accepts it. */
  const [drag, setDrag] = useState<'hint' | 'drop'>();
  const addImages = (files: File[]) => {
    if (!tabId || !files.length) return;
    void attachImages(tabId, files).then((err) => err && showNotice('error', err));
  };
  const dropRef = useRef({ tabId, addImages, showNotice });
  dropRef.current = { tabId, addImages, showNotice };
  // Window-wide: VS Code only lets a file drop into a webview while Shift is held. Without Shift
  // the webview sees the first drag events and then VS Code takes over, so we show a hint that
  // fades once events stop; with Shift, the whole panel becomes a drop target.
  useEffect(() => {
    if (disabled) return;
    const hasDropData = (dt: DataTransfer | null) =>
      !!dt && [...dt.types].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'application/vnd.code.uri-list');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      clearTimeout(timer);
      setDrag(undefined);
    };
    const onOver = (e: globalThis.DragEvent) => {
      if (!hasDropData(e.dataTransfer)) return;
      clearTimeout(timer);
      if (e.shiftKey) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
        setDrag('drop');
        timer = setTimeout(clear, 600);
      } else {
        setDrag('hint');
        timer = setTimeout(clear, 3000);
      }
    };
    const onLeave = (e: globalThis.DragEvent) => {
      if (!e.relatedTarget) setDrag((d) => (d === 'drop' ? undefined : d));
    };
    const onDrop = (e: globalThis.DragEvent) => {
      clear();
      const dt = e.dataTransfer;
      const { tabId: id, addImages: add, showNotice: notice } = dropRef.current;
      if (!id || !hasDropData(dt)) return;
      e.preventDefault();
      const files = imageFiles(dt!.files);
      if (files.length) return add(files);
      const uris = imageUris(dt!);
      if (uris.length) send({ type: 'image/addUris', tabId: id, uris });
      else if (dt!.files.length) notice('warning', 'Only images can be dropped here (PNG, JPEG, GIF, WebP, BMP). Use @ for other files.');
    };
    window.addEventListener('dragenter', onOver);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('dragenter', onOver);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [disabled]);
  const images = chips.filter((c): c is Extract<ContextChip, { kind: 'image' }> => c.kind === 'image');

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
                  key={`${m.root ?? ''}|${m.path}`}
                  icon={<FileIcon />}
                  label={
                    <>
                      {m.path.split('/').pop()}
                      {m.isFolder ? '/' : ''}
                    </>
                  }
                  trailing={
                    <span className="option-hint">
                      {m.folder && <span className="option-folder">{m.folder}</span>}
                      {m.path}
                    </span>
                  }
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
        className={`composer-box${disabled ? ' disabled' : ''}${drag === 'drop' ? ' drag-over' : ''}`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setTimeout(() => ref.current?.focus(), 0);
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept={IMAGE_TYPES.join(',')}
          multiple
          hidden
          onChange={(e) => {
            addImages(imageFiles(e.currentTarget.files));
            e.currentTarget.value = '';
          }}
        />
        <ImageThumbs images={images} tabId={tabId} />
        <div
          ref={ref}
          className={`composer-input${text ? '' : ' is-empty'}`}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Message"
          data-placeholder={running ? 'Working… press Esc to stop' : PLACEHOLDER[mode]}
          onInput={(e) => {
            const el = e.currentTarget;
            const v = serialize(el);
            // Chips deleted with Backspace/Delete/cut leave the tab too.
            const left = new Set(chipIdsIn(v));
            for (const id of [...known.current]) {
              if (left.has(id)) continue;
              known.current.delete(id);
              if (tabId) send({ type: 'chip/remove', tabId, chipId: id });
            }
            if (!v && el.childNodes.length) el.replaceChildren();
            setText(v);
            const c = getCaret(el);
            if (c !== undefined) caretRef.current = c;
            detectPopup(v, c ?? v.length);
          }}
          onKeyUp={trackCaret}
          onMouseUp={trackCaret}
          onClick={(e: MouseEvent<HTMLDivElement>) => {
            const target = e.target as HTMLElement;
            const removeId = target.closest<HTMLElement>('[data-remove]')?.dataset.remove;
            if (removeId) {
              e.preventDefault();
              known.current.delete(removeId);
              const t = textRef.current.replace(chipToken(removeId), '').replace(/ {2,}/g, ' ');
              apply(t, Math.min(caretRef.current ?? t.length, t.length));
              if (tabId) send({ type: 'chip/remove', tabId, chipId: removeId });
              return;
            }
            const chipId = target.closest<HTMLElement>('[data-chip]')?.dataset.chip;
            const chip = chipId ? chips.find((c) => c.id === chipId) : undefined;
            if (chip) return openChip(chip);
            const c = getCaret(e.currentTarget);
            detectPopup(text, c ?? text.length);
          }}
          onBlur={() => setTimeout(() => setPopup(undefined), 150)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            e.preventDefault();
            // Screenshots (Win+Shift+S) and copied images arrive as clipboard files.
            const files = imageFiles(e.clipboardData.files);
            if (files.length) return addImages(files);
            // Plain text only: no pasted HTML in the input.
            const pasted = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').replace(/[]/g, '');
            if (!pasted) return;
            const c = getCaret(e.currentTarget) ?? text.length;
            const next = text.slice(0, c) + pasted + text.slice(c);
            apply(next, c + pasted.length);
            detectPopup(next, c + pasted.length);
          }}
          onDrop={(e) => {
            // Dropped text arrives as plain text too; files/images are handled by the box.
            const plainText = e.dataTransfer.getData('text/plain');
            if (!plainText || [...e.dataTransfer.types].some((t) => t === 'Files' || t === 'application/vnd.code.uri-list')) return;
            e.preventDefault();
            e.stopPropagation();
            const c = caretRef.current ?? text.length;
            apply(text.slice(0, c) + plainText + text.slice(c), c + plainText.length);
          }}
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
                  icon={<span className="glyph">🖼</span>}
                  label="Attach image"
                  description="Or paste a screenshot / hold Shift and drop an image"
                  onPick={() => {
                    setAttachOpen(false);
                    fileInput.current?.click();
                  }}
                />
                <OptionRow
                  icon={<span className="glyph">⌶</span>}
                  label="Add editor selection"
                  description="Ctrl+I in the editor"
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
      {drag === 'drop' && (
        <div className="drop-overlay" aria-hidden>
          <span className="drop-overlay-label">Drop to attach image</span>
        </div>
      )}
      {drag === 'hint' && (
        <div className="drop-hint" role="status">
          Hold <kbd>Shift</kbd> while dragging to drop images here
        </div>
      )}
    </div>
  );
}
