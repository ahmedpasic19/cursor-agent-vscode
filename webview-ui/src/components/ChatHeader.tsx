import { useEffect, useRef, useState } from 'react';
import { ClockIcon, PlusIcon } from '../sessions/icons';
import type { TabMeta } from '../state/store';
import { send } from '../vscode';

/**
 * One session per panel: title (double-click or F2 to rename),
 * running indicator, sessions/history, new session, settings. Switching sessions happens in the
 * Session Manager on the left.
 */
export function ChatHeader({ tab, queued }: { tab?: TabMeta; queued: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="chat-header">
      {tab?.running && <span className="running-dot small" title={queued ? 'Queued' : 'Running'} aria-label={queued ? 'queued' : 'running'} />}
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
          title={tab ? `${tab.title}\nDouble-click or F2 to rename` : undefined}
          tabIndex={tab ? 0 : -1}
          onDoubleClick={startRename}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault();
              startRename();
            }
          }}
        >
          {untitled ? 'Untitled' : tab.title}
        </span>
      )}
      <button className="icon-btn" title="Sessions (Session Manager)" aria-label="Show sessions" onClick={() => send({ type: 'sessions/show' })}>
        <ClockIcon />
      </button>
      <button className="icon-btn" title="New session (Alt+N)" aria-label="New session" onClick={() => send({ type: 'tab/new' })}>
        <PlusIcon />
      </button>
      <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => send({ type: 'settings/open', query: 'cursorAgent' })}>
        ⚙
      </button>
    </div>
  );
}
