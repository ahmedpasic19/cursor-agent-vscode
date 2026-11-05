import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { send } from '../vscode';

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Searchable list of past chats in this workspace (PLAN.md §5.7). */
export function HistoryView() {
  const items = useStore((s) => s.history);
  const setOpen = useStore((s) => s.setHistoryOpen);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    send({ type: 'history/request' });
    ref.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return items;
    return items.filter((i) => {
      const hay = `${i.title}\n${i.preview}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, q]);

  return (
    <div className="history">
      <div className="history-search">
        <input
          ref={ref}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${items.length} chat${items.length === 1 ? '' : 's'}…`}
          aria-label="Search chat history"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Enter' && filtered[0]) send({ type: 'history/open', id: filtered[0].id });
          }}
        />
      </div>
      {filtered.length === 0 ? (
        <div className="empty muted">{items.length ? 'No chats match.' : 'No saved chats in this workspace yet.'}</div>
      ) : (
        <ul className="history-list">
          {filtered.map((i) => (
            <li key={i.id} className="history-item">
              <button className="history-open" onClick={() => send({ type: 'history/open', id: i.id })}>
                <span className="history-title">
                  {i.open && <span className="open-badge">open</span>}
                  {i.title}
                </span>
                <span className="history-preview">{i.preview}</span>
                <span className="history-meta">
                  {ago(i.updatedAt)} · {i.messageCount} message{i.messageCount === 1 ? '' : 's'}
                </span>
              </button>
              <button
                className="icon-btn small history-delete"
                title="Delete chat"
                aria-label={`Delete ${i.title}`}
                onClick={() => send({ type: 'history/delete', id: i.id })}
              >
                🗑
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
