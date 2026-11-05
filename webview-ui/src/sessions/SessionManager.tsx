import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { SessionGroup, SessionRow } from '../../../src/shared/protocol';
import { send } from '../vscode';
import { BoltIcon, ChevronIcon, ClockIcon, CloseIcon, FilterIcon, PlusIcon, SearchIcon, TrashIcon, WarnIcon } from './icons';
import { isActive, matchesSearch, relativeTime, type SortKey, useSessions } from './store';

const DRAG_TYPE = 'application/x-cursor-session';
const UNGROUPED = '__ungrouped__';

/** Move keyboard focus to the previous/next session row or group header. */
function moveFocus(from: HTMLElement, dir: 1 | -1): void {
  const all = [...document.querySelectorAll<HTMLElement>('[data-nav]')];
  const i = all.indexOf(from);
  all[i + dir]?.focus();
}

function StatusIcon({ row }: { row: SessionRow }) {
  switch (row.status) {
    case 'running':
      return <span className="spinner" aria-label="running" title="Running" />;
    case 'queued':
      return (
        <span className="status-icon muted" aria-label="queued" title="Queued">
          <ClockIcon />
        </span>
      );
    case 'interrupted':
      return (
        <span className="status-icon warn" aria-label="interrupted" title="Interrupted when VS Code closed — open it to resume">
          <WarnIcon />
        </span>
      );
    case 'error':
      return <span className="dot error" aria-label="last run failed" title="Last run failed" />;
    default:
      return row.unread ? <span className="dot unread" aria-label="new activity" title="Finished while you were elsewhere" /> : <span className="dot none" />;
  }
}

function Row({ row, active, now }: { row: SessionRow; active: boolean; now: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = () => {
    if (draft.trim() && draft.trim() !== row.title) send({ type: 'tab/rename', tabId: row.id, title: draft.trim() });
    setEditing(false);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      send({ type: 'session/open', id: row.id });
    } else if (e.key === 'F2') {
      e.preventDefault();
      setDraft(row.title);
      setEditing(true);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      send({ type: 'session/delete', id: row.id });
    }
  };

  return (
    <div
      className={`session-row${active ? ' active' : ''}${row.unread ? ' unread' : ''}`}
      role="option"
      aria-selected={active}
      tabIndex={0}
      data-nav
      draggable={!editing}
      title={`${row.title}\n${row.messageCount} message${row.messageCount === 1 ? '' : 's'} · updated ${new Date(row.updatedAt).toLocaleString()}\n\n${row.preview.slice(0, 200)}`}
      onClick={() => !editing && send({ type: 'session/open', id: row.id })}
      onDoubleClick={(e) => {
        e.preventDefault();
        setDraft(row.title);
        setEditing(true);
      }}
      onKeyDown={onKey}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, row.id);
        e.dataTransfer.effectAllowed = 'move';
        document.body.classList.add('dragging');
      }}
      onDragEnd={() => document.body.classList.remove('dragging')}
    >
      <StatusIcon row={row} />
      {editing ? (
        <input
          ref={input}
          className="inline-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label="Rename session"
        />
      ) : (
        <span className="session-title">{row.title}</span>
      )}
      <span className="session-time">{row.status === 'running' ? '' : relativeTime(row.updatedAt, now)}</span>
      <button
        className="row-action"
        tabIndex={-1}
        title="Delete session"
        aria-label={`Delete ${row.title}`}
        onClick={(e) => {
          e.stopPropagation();
          send({ type: 'session/delete', id: row.id });
        }}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

/** Drop target: a group header, or the ungrouped area. */
function useDrop(groupId: string | undefined) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        setOver(false);
        document.body.classList.remove('dragging');
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        send({ type: 'session/move', id, groupId });
      },
    },
  };
}

function Group({ group, count, forceOpen, children }: { group: SessionGroup; count: number; forceOpen: boolean; children: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const input = useRef<HTMLInputElement>(null);
  const drop = useDrop(group.id);
  const open = forceOpen || !group.collapsed;
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const toggle = () => send({ type: 'group/toggle', id: group.id, collapsed: !group.collapsed });
  const commit = () => {
    if (draft.trim() && draft.trim() !== group.name) send({ type: 'group/rename', id: group.id, name: draft.trim() });
    setEditing(false);
  };

  return (
    <div className="group" role="group" aria-label={group.name}>
      <div
        className={`group-header${drop.over ? ' drop' : ''}`}
        tabIndex={0}
        data-nav
        aria-expanded={open}
        onClick={() => !editing && toggle()}
        onDoubleClick={() => {
          setDraft(group.name);
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (editing) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            moveFocus(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
          } else if (e.key === 'Enter' || e.key === ' ' || (e.key === 'ArrowLeft' && open) || (e.key === 'ArrowRight' && !open)) {
            e.preventDefault();
            toggle();
          } else if (e.key === 'F2') {
            e.preventDefault();
            setDraft(group.name);
            setEditing(true);
          }
        }}
        {...drop.props}
      >
        <ChevronIcon open={open} />
        {editing ? (
          <input
            ref={input}
            className="inline-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
            aria-label="Rename group"
          />
        ) : (
          <span className="group-name">{group.name}</span>
        )}
        <span className="group-count">{count}</span>
        <button
          className="row-action"
          tabIndex={-1}
          title="Delete group (its sessions are kept)"
          aria-label={`Delete group ${group.name}`}
          onClick={(e) => {
            e.stopPropagation();
            send({ type: 'group/delete', id: group.id });
          }}
        >
          <CloseIcon />
        </button>
      </div>
      {open && <div className="group-body">{children}</div>}
      {open && count === 0 && <div className="group-empty muted">Drag sessions here</div>}
    </div>
  );
}

function NewGroupInput({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const commit = () => {
    if (name.trim()) send({ type: 'group/create', name: name.trim() });
    onDone();
  };
  return (
    <div className="group-header new">
      <ChevronIcon open={false} />
      <input
        ref={ref}
        className="inline-input"
        placeholder="Group name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') onDone();
        }}
        aria-label="New group name"
      />
    </div>
  );
}

const SORTS: { id: SortKey; label: string }[] = [
  { id: 'updated', label: 'Last updated' },
  { id: 'created', label: 'Date created' },
];

/** Session Manager. */
export function SessionManagerBody() {
  const { rows, groups, activeId, sort, activeOnly, searchRequest, now: stateNow } = useSessions();
  const setPref = useSessions((s) => s.set);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [now, setNow] = useState(Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const ungroupedDrop = useDrop(undefined);

  // Relative times refresh every minute, and whenever new state arrives.
  useEffect(() => setNow(Math.max(Date.now(), stateNow)), [stateNow]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!searchRequest) return;
    setSearchOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchRequest]);

  const activeCount = useMemo(() => rows.filter(isActive).length, [rows]);
  const searching = !!query.trim();

  const visible = useMemo(() => {
    const out = rows.filter((r) => (!activeOnly || isActive(r)) && matchesSearch(r, query));
    const key = sort === 'created' ? 'createdAt' : 'updatedAt';
    return out.sort((a, b) => b[key] - a[key]);
  }, [rows, activeOnly, query, sort]);

  const byGroup = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const r of visible) {
      const k = r.groupId && groups.some((g) => g.id === r.groupId) ? r.groupId : UNGROUPED;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  }, [visible, groups]);

  const ungrouped = byGroup.get(UNGROUPED) ?? [];
  const filtering = activeOnly || searching;
  const shownGroups = filtering ? groups.filter((g) => byGroup.has(g.id)) : groups;

  return (
    <div className="session-manager">
      <button className="new-session" onClick={() => send({ type: 'tab/new' })}>
        <PlusIcon />
        <span>New session</span>
      </button>

      <div className="toolbar" role="toolbar" aria-label="Session filters">
        <div className="menu-anchor">
          <button
            className={`tool-btn${sortOpen ? ' toggled' : ''}`}
            title={`Sort: ${SORTS.find((s) => s.id === sort)!.label}`}
            aria-label="Sort sessions"
            aria-haspopup="menu"
            aria-expanded={sortOpen}
            onClick={() => setSortOpen((o) => !o)}
          >
            <FilterIcon />
            <span className="caret">▾</span>
          </button>
          {sortOpen && (
            <div className="menu" role="menu" onMouseLeave={() => setSortOpen(false)}>
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  role="menuitemradio"
                  aria-checked={sort === s.id}
                  className="menu-item"
                  onClick={() => {
                    setPref('sort', s.id);
                    setSortOpen(false);
                  }}
                >
                  <span className="check">{sort === s.id ? '✓' : ''}</span>
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className={`tool-btn${activeOnly ? ' toggled' : ''}`}
          aria-pressed={activeOnly}
          title={activeOnly ? 'Showing running sessions only' : 'Show running sessions only'}
          onClick={() => setPref('activeOnly', !activeOnly)}
        >
          <BoltIcon />
          <span>Active · {activeCount}</span>
        </button>
        <button
          className={`tool-btn${searchOpen ? ' toggled' : ''}`}
          title="Search sessions"
          aria-label="Search sessions"
          aria-pressed={searchOpen}
          onClick={() => {
            if (searchOpen) setQuery('');
            setSearchOpen(!searchOpen);
            if (!searchOpen) requestAnimationFrame(() => searchRef.current?.focus());
          }}
        >
          <SearchIcon />
        </button>
        <button className="tool-btn" title="New group" onClick={() => setCreatingGroup(true)}>
          <PlusIcon />
          <span>New group</span>
        </button>
      </div>

      {searchOpen && (
        <div className="search">
          <input
            ref={searchRef}
            value={query}
            placeholder={`Search ${rows.length} session${rows.length === 1 ? '' : 's'}…`}
            aria-label="Search sessions"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                setSearchOpen(false);
              } else if (e.key === 'Enter' && visible[0]) {
                send({ type: 'session/open', id: visible[0].id });
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                document.querySelector<HTMLElement>('[data-nav]')?.focus();
              }
            }}
          />
        </div>
      )}

      <div className="session-list" role="listbox" aria-label="Sessions">
        {creatingGroup && <NewGroupInput onDone={() => setCreatingGroup(false)} />}
        {shownGroups.map((g) => {
          const items = byGroup.get(g.id) ?? [];
          return (
            <Group key={g.id} group={g} count={items.length} forceOpen={filtering}>
              {items.map((r) => (
                <Row key={r.id} row={r} active={r.id === activeId} now={now} />
              ))}
            </Group>
          );
        })}
        {groups.length > 0 && (
          <div className={`ungroup-drop${ungroupedDrop.over ? ' drop' : ''}`} {...ungroupedDrop.props}>
            Drop here to remove from group
          </div>
        )}
        <div className="ungrouped" {...ungroupedDrop.props}>
          {ungrouped.map((r) => (
            <Row key={r.id} row={r} active={r.id === activeId} now={now} />
          ))}
        </div>
        {visible.length === 0 && (
          <div className="pad muted empty-list">
            {rows.length === 0
              ? 'No sessions yet. Start one with New session, or select code and press Ctrl+L.'
              : activeOnly && !searching
                ? 'No sessions are running.'
                : 'No sessions match.'}
          </div>
        )}
      </div>
    </div>
  );
}
