import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '../state/store';
import { send } from '../vscode';

/** Chat tabs (PLAN.md §5.1): running/unread dots, double-click to rename, × to close. */
export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const order = useStore((s) => s.tabOrder);
  const activeId = useStore((s) => s.activeTabId);
  const unread = useStore((s) => s.unread);
  const activate = useStore((s) => s.activate);
  const historyOpen = useStore((s) => s.historyOpen);
  const setHistoryOpen = useStore((s) => s.setHistoryOpen);
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  const pick = (id: string) => {
    if (id === activeId && !historyOpen) return;
    activate(id);
    send({ type: 'tab/activate', tabId: id });
  };

  const commitRename = () => {
    if (editing && draft.trim()) send({ type: 'tab/rename', tabId: editing, title: draft.trim() });
    setEditing(undefined);
  };

  const onTabKey = (e: KeyboardEvent, id: string, i: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      if (next) {
        pick(next);
        (document.querySelector(`[data-tab-id="${next}"]`) as HTMLElement | null)?.focus();
      }
    } else if (e.key === 'Delete') {
      e.preventDefault();
      send({ type: 'tab/close', tabId: id });
    } else if (e.key === 'F2') {
      e.preventDefault();
      setDraft(tabs[id]?.meta.title ?? '');
      setEditing(id);
    }
  };

  return (
    <div className="tabbar" role="tablist" aria-label="Chats">
      <div className="tabs-scroll">
        {order.map((id, i) => {
          const t = tabs[id];
          if (!t) return null;
          const active = id === activeId && !historyOpen;
          const queued = t.transcript.some((x) => x.role === 'run' && x.status === 'queued');
          return (
            <div
              key={id}
              ref={id === activeId ? activeRef : undefined}
              className={`tab${active ? ' active' : ''}`}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-tab-id={id}
              title={`${t.meta.title}${t.meta.running ? (queued ? ' — queued' : ' — running') : ''}\nDouble-click or F2 to rename`}
              onClick={() => pick(id)}
              onDoubleClick={() => {
                setDraft(t.meta.title);
                setEditing(id);
              }}
              onKeyDown={(e) => onTabKey(e, id, i)}
              onAuxClick={(e) => e.button === 1 && send({ type: 'tab/close', tabId: id })}
            >
              {t.meta.running ? (
                <span className={`tab-dot ${queued ? 'queued' : 'running'}`} aria-label={queued ? 'queued' : 'running'} />
              ) : unread[id] ? (
                <span className="tab-dot unread" aria-label="new activity" />
              ) : null}
              {editing === id ? (
                <input
                  ref={inputRef}
                  className="tab-rename"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditing(undefined);
                  }}
                  aria-label="Rename chat"
                />
              ) : (
                <span className="tab-title">{t.meta.title}</span>
              )}
              <button
                className="tab-close"
                aria-label={`Close ${t.meta.title}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  send({ type: 'tab/close', tabId: id });
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button
        className={`icon-btn${historyOpen ? ' toggled' : ''}`}
        title="Chat history"
        aria-label="Chat history"
        aria-pressed={historyOpen}
        onClick={() => {
          if (!historyOpen) send({ type: 'history/request' });
          setHistoryOpen(!historyOpen);
        }}
      >
        ⏱
      </button>
      <button className="icon-btn" title="New chat (Alt+N)" aria-label="New chat" onClick={() => send({ type: 'tab/new' })}>
        +
      </button>
      <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => send({ type: 'settings/open', query: 'cursorAgent' })}>
        ⚙
      </button>
    </div>
  );
}
