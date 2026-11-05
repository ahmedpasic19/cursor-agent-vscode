import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { SessionRow } from '../../../src/shared/protocol';
import { ClockIcon, PlusIcon, SearchIcon } from '../sessions/icons';
import { relativeTime } from '../sessions/store';
import { useStore, type TabMeta } from '../state/store';
import { send } from '../vscode';
import { Mascot } from './Mascot';
import { Popover } from './Popover';

/**
 * One session per panel: title (double-click or F2 to rename), history dropdown, new session.
 * Settings live in the Sessions view on the left.
 */
export function ChatHeader({ tab, queued }: { tab?: TabMeta; queued: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRequest = useStore((s) => s.historyRequest);

  useEffect(() => {
    if (historyRequest > 0) setHistoryOpen(true);
  }, [historyRequest]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  useEffect(() => setEditing(false), [tab?.id]);

  const untitled = !tab || tab.title === 'New chat';
  const startRename = () => {
    if (!tab) return;
    setDraft(untitled ? '' : tab.title);
    setEditing(true);
  };
  const commit = () => {
    if (tab && draft.trim()) send({ type: 'tab/rename', tabId: tab.id, title: draft.trim() });
    setEditing(false);
  };
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  return (
    <div className="chat-header">
      {tab?.running && <Mascot size={14} state="working" className="header-mascot" />}
      {editing ? (
        <input
          ref={inputRef}
          className="chat-rename"
          value={draft}
          placeholder="Session name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label="Rename session"
        />
      ) : (
        <span
          className={`chat-title${untitled ? ' untitled' : ''}`}
          title={tab ? `${tab.title}${queued ? ' (queued)' : ''}\nDouble-click or F2 to rename` : undefined}
          tabIndex={tab ? 0 : -1}
          onDoubleClick={startRename}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault();
              startRename();
            }
          }}
        >
          {untitled ? 'New session' : tab.title}
        </span>
      )}
      <div className="history-anchor">
        <button
          className={`icon-btn${historyOpen ? ' toggled' : ''}`}
          title="Past sessions"
          aria-label="Past sessions"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen(!historyOpen)}
        >
          <ClockIcon />
        </button>
        <Popover open={historyOpen} onClose={closeHistory} placement="below" align="right" className="history-popover" label="Past sessions">
          <HistoryList activeId={tab?.id} onDone={closeHistory} />
        </Popover>
      </div>
      <button className="icon-btn" title="New session (Alt+N)" aria-label="New session" onClick={() => send({ type: 'tab/new' })}>
        <PlusIcon />
      </button>
    </div>
  );
}

const DAY = 86_400_000;
function bucket(ts: number, now: number): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (ts >= today) return 'Today';
  if (ts >= today - DAY) return 'Yesterday';
  if (ts >= today - 7 * DAY) return 'Last 7 days';
  if (ts >= today - 30 * DAY) return 'Last 30 days';
  return 'Older';
}

function HistoryList({ activeId, onDone }: { activeId?: string; onDone(): void }) {
  const rows = useStore((s) => s.sessionRows);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const now = Date.now();

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const list = useMemo(() => {
    const f = q.trim().toLowerCase();
    return [...rows]
      .filter((r) => r.messageCount > 0 || r.id === activeId)
      .filter((r) => !f || r.title.toLowerCase().includes(f) || r.preview.toLowerCase().includes(f))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200);
  }, [rows, q, activeId]);

  const open = (r?: SessionRow) => {
    if (!r) return;
    if (r.id !== activeId) send({ type: 'session/open', id: r.id });
    onDone();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, list.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(list[active]);
    }
  };

  let lastBucket = '';
  return (
    <>
      <div className="popover-search">
        <SearchIcon />
        <input
          ref={inputRef}
          value={q}
          placeholder="Search sessions"
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
          aria-label="Search sessions"
        />
      </div>
      <div className="option-list history-list" role="listbox" aria-label="Past sessions">
        {list.map((r, i) => {
          const b = bucket(r.updatedAt, now);
          const head = b !== lastBucket ? b : undefined;
          lastBucket = b;
          return (
            <div key={r.id}>
              {head && <div className="option-section">{head}</div>}
              <div
                role="option"
                aria-selected={r.id === activeId}
                className={`history-row${i === active ? ' active' : ''}${r.id === activeId ? ' current' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  open(r);
                }}
                title={r.preview || r.title}
              >
                {r.status === 'running' ? <span className="live-dot" aria-label="running" /> : r.unread ? <span className="unread-dot" aria-label="unread" /> : <span className="dot-space" />}
                <span className="history-title">{r.title || 'Untitled'}</span>
                <span className="history-time">{r.status === 'running' ? 'running' : relativeTime(r.updatedAt, now)}</span>
              </div>
            </div>
          );
        })}
        {!list.length && <div className="option-empty">{q ? 'No sessions match.' : 'No past sessions yet.'}</div>}
      </div>
      <div className="popover-footer">
        <button
          className="ghost-btn"
          onMouseDown={(e) => {
            e.preventDefault();
            send({ type: 'sessions/reveal' });
            onDone();
          }}
        >
          Manage sessions…
        </button>
      </div>
    </>
  );
}
