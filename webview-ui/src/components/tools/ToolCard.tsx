import { useState, type ReactNode } from 'react';
import type { ToolCallInfo } from '../../../../src/shared/events';
import { send } from '../../vscode';
import { Markdown } from '../Markdown';
import { absPath, isObj, num, relPath, str, stripAnsi, truncateLines, useTab } from './util';

export type ToolStatus = 'running' | 'done' | 'error';

interface ShellProps {
  status: ToolStatus;
  title: ReactNode;
  /** Optional click action on the title (e.g. open file); the chevron still toggles. */
  onTitleClick?: () => void;
  titleHint?: string;
  children?: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  /** Replaces the status icon (e.g. "?" for unrecognized events). */
  icon?: ReactNode;
}

/** Compact one-line card with an expandable body (PLAN.md §5.5). */
function CardShell({ status, title, onTitleClick, titleHint, children, className, defaultOpen, icon: iconOverride }: ShellProps) {
  const [open, setOpen] = useState(!!defaultOpen);
  const expandable = children !== undefined && children !== null && children !== false;
  const icon =
    iconOverride ??
    (status === 'running' ? <span className="spinner" aria-label="running" /> : status === 'error' ? '✕' : '✓');
  return (
    <div className={`tool-card ${status} ${className ?? ''}`}>
      <div className="tool-header-row">
        <button
          className="tool-header"
          onClick={() => (expandable ? setOpen(!open) : onTitleClick?.())}
          aria-expanded={expandable ? open : undefined}
        >
          <span className="tool-icon">{icon}</span>
          {onTitleClick ? (
            <span
              className="tool-title clickable"
              title={titleHint}
              role="link"
              onClick={(e) => {
                e.stopPropagation();
                onTitleClick();
              }}
            >
              {title}
            </span>
          ) : (
            <span className="tool-title" title={titleHint}>
              {title}
            </span>
          )}
          {expandable && <span className="chevron">{open ? '▾' : '▸'}</span>}
        </button>
      </div>
      {expandable && open && <div className="tool-body">{children}</div>}
    </div>
  );
}

function ErrorLine({ tool }: { tool: ToolCallInfo }) {
  return tool.error ? <div className="tool-error">{tool.error}</div> : null;
}

// ---------- read ----------

function ReadCard({ tool, status }: { tool: ToolCallInfo; status: ToolStatus }) {
  const { cwd } = useTab();
  const path = str(tool.args.path) ?? '';
  const range = isObj(tool.result?.readRange) ? tool.result!.readRange : undefined;
  const a = num(range?.startLine) ?? num(tool.args.offset);
  const b = num(range?.endLine) ?? (a !== undefined && num(tool.args.limit) ? a + num(tool.args.limit)! - 1 : undefined);
  const lines = a !== undefined ? (b !== undefined && b !== a ? ` (Ln ${a}–${b})` : ` (Ln ${a})`) : '';
  return (
    <CardShell
      status={status}
      title={
        <>
          Read <span className="path">{relPath(path, cwd)}</span>
          <span className="muted">{lines}</span>
        </>
      }
      titleHint={`Open ${path}`}
      onTitleClick={() => send({ type: 'file/open', path: absPath(path, cwd), line: a, endLine: b })}
    >
      {tool.error ? <ErrorLine tool={tool} /> : null}
    </CardShell>
  );
}

// ---------- edit ----------

function MiniDiff({ diff }: { diff: string }) {
  const lines = diff.split('\n').filter((l) => !l.startsWith('--- ') && !l.startsWith('+++ '));
  const { text, cut } = truncateLines(lines.join('\n'), 80);
  return (
    <pre className="mini-diff">
      {text.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>
          {l || ' '}
        </div>
      ))}
      {cut > 0 && <div className="muted">… {cut} more lines</div>}
    </pre>
  );
}

function EditCard({ tool, status }: { tool: ToolCallInfo; status: ToolStatus }) {
  const { cwd } = useTab();
  const r = tool.result;
  const path = str(r?.path) ?? str(tool.args.path) ?? '';
  const isNew = !!r && str(r.beforeFullFileContent) === undefined && /\/dev\/null/.test(str(r.diffString) ?? '');
  const add = num(r?.linesAdded);
  const del = num(r?.linesRemoved);
  // Expected on Plan → Agent: the resumed session is still in plan mode until the agent switches
  // (docs/CLI_NOTES.md §7). Show it muted rather than as a red failure.
  const blocked = status === 'error' && /in (plan|ask) mode/i.test(tool.error ?? '');
  const verb = status === 'running' ? 'Editing' : blocked ? 'Edit blocked by mode' : status === 'error' ? 'Edit failed' : isNew ? 'Created' : 'Edited';
  const diff = str(r?.diffString);
  return (
    <CardShell
      status={status}
      className={blocked ? 'blocked' : undefined}
      icon={blocked ? '⏸' : undefined}
      title={
        <>
          {verb} <span className="path">{relPath(path, cwd)}</span>
          {add !== undefined && <span className="add-count"> +{add}</span>}
          {del !== undefined && <span className="del-count"> −{del}</span>}
        </>
      }
      titleHint={path}
    >
      {tool.error ? (
        <ErrorLine tool={tool} />
      ) : diff ? (
        <>
          <MiniDiff diff={diff} />
          <div className="tool-actions">
            <button
              className="link"
              onClick={() => send({ type: 'tool/openDiff', path: absPath(path, cwd), before: str(r?.beforeFullFileContent) ?? '' })}
            >
              Open diff
            </button>
            <button className="link" onClick={() => send({ type: 'file/open', path: absPath(path, cwd) })}>
              Open file
            </button>
          </div>
        </>
      ) : status === 'running' ? null : undefined}
    </CardShell>
  );
}

// ---------- delete ----------

function DeleteCard({ tool, status }: { tool: ToolCallInfo; status: ToolStatus }) {
  const { cwd } = useTab();
  const path = str(tool.result?.path) ?? str(tool.args.path) ?? '';
  return (
    <CardShell
      status={status}
      title={
        <>
          {status === 'running' ? 'Deleting' : 'Deleted'} <span className="path">{relPath(path, cwd)}</span>
        </>
      }
    >
      {tool.error ? <ErrorLine tool={tool} /> : <div className="muted">Restore is available from the Changes card (Phase 4).</div>}
    </CardShell>
  );
}

// ---------- shell ----------

function ShellCard({ tool, status }: { tool: ToolCallInfo; status: ToolStatus }) {
  const r = tool.result;
  const cmd = str(tool.args.command) ?? str(r?.command) ?? '';
  const out = stripAnsi(str(r?.interleavedOutput) || [str(r?.stdout), str(r?.stderr)].filter(Boolean).join('\n') || '');
  const code = num(r?.exitCode);
  const { text, cut } = truncateLines(out.replace(/\s+$/, ''), 200);
  const failed = status === 'error' || (code !== undefined && code !== 0);
  return (
    <CardShell
      status={failed && status !== 'running' ? 'error' : status}
      title={<span className="mono">$ {cmd}</span>}
      titleHint={str(tool.args.description) ?? cmd}
    >
      <ErrorLine tool={tool} />
      {text ? <pre className="shell-out">{text}</pre> : status !== 'running' && <div className="muted">(no output)</div>}
      {cut > 0 && <div className="muted">… {cut} more lines</div>}
      {code !== undefined && <div className={`exit-code ${code === 0 ? '' : 'bad'}`}>exit code {code}</div>}
    </CardShell>
  );
}

// ---------- search (glob / grep / ls / ...) ----------

interface Hit {
  path: string;
  line?: number;
  text?: string;
}

function collectHits(tool: ToolCallInfo): { hits: Hit[]; total?: number } {
  const r = tool.result;
  if (!r) return { hits: [] };
  if (Array.isArray(r.files)) {
    return { hits: r.files.filter((f): f is string => typeof f === 'string').map((path) => ({ path })), total: num(r.totalFiles) };
  }
  // grep: workspaceResults{root: {content: {matches: [...]}}} — match shape not observed yet; read defensively.
  const hits: Hit[] = [];
  let total: number | undefined;
  const visit = (m: unknown, file?: string) => {
    if (!isObj(m)) return;
    const f = str(m.file) ?? str(m.path) ?? file;
    if (Array.isArray(m.matches)) {
      for (const x of m.matches) visit(x, f);
      return;
    }
    if (f) hits.push({ path: f, line: num(m.lineNumber) ?? num(m.line), text: str(m.content) ?? str(m.text) });
  };
  if (isObj(r.workspaceResults)) {
    for (const ws of Object.values(r.workspaceResults)) {
      if (!isObj(ws)) continue;
      for (const v of Object.values(ws)) {
        if (!isObj(v)) continue;
        total = (total ?? 0) + (num(v.totalMatchedLines) ?? num(v.totalFiles) ?? 0);
        if (Array.isArray(v.matches)) v.matches.forEach((m) => visit(m));
        if (Array.isArray(v.files)) v.files.forEach((f) => typeof f === 'string' && hits.push({ path: f }));
      }
    }
  }
  return { hits, total: total ?? hits.length };
}

function SearchCard({ tool, status }: { tool: ToolCallInfo; status: ToolStatus }) {
  const { cwd } = useTab();
  const a = tool.args;
  const q = str(a.globPattern) ?? str(a.pattern) ?? str(a.query) ?? str(a.searchTerm) ?? str(a.path) ?? '';
  const { hits, total } = collectHits(tool);
  const verb = tool.name === 'ls' || tool.name === 'list' ? 'Listed' : 'Searched';
  const count = status === 'running' ? '' : ` (${total ?? hits.length} result${(total ?? hits.length) === 1 ? '' : 's'})`;
  return (
    <CardShell
      status={status}
      title={
        <>
          {verb} <span className="mono">"{q}"</span>
          <span className="muted">{count}</span>
        </>
      }
    >
      <ErrorLine tool={tool} />
      {hits.length > 0 && (
        <ul className="hit-list">
          {hits.slice(0, 100).map((h, i) => (
            <li key={i}>
              <button className="link" onClick={() => send({ type: 'file/open', path: absPath(h.path, cwd), line: h.line })}>
                {relPath(h.path, cwd)}
                {h.line !== undefined && `:${h.line}`}
              </button>
              {h.text && <span className="hit-text"> {h.text.trim()}</span>}
            </li>
          ))}
          {hits.length > 100 && <li className="muted">… {hits.length - 100} more</li>}
        </ul>
      )}
      {!tool.error && hits.length === 0 && status !== 'running' && <div className="muted">No results.</div>}
    </CardShell>
  );
}

// ---------- plan ----------

export function PlanCard({ tool, status, canExecute }: { tool: ToolCallInfo; status: ToolStatus; canExecute: boolean }) {
  const { tabId, running } = useTab();
  const a = tool.args;
  const plan = str(a.plan) ?? '';
  const todos = Array.isArray(a.todos) ? a.todos.filter(isObj) : [];
  return (
    <div className={`plan-card ${status}`}>
      <div className="plan-header">
        <span className="plan-label">Plan</span>
        <span className="plan-name">{str(a.name) ?? ''}</span>
      </div>
      {plan ? <Markdown text={plan} /> : status === 'running' ? <div className="muted">Writing plan…</div> : null}
      {todos.length > 0 && (
        <ul className="todo-list">
          {todos.map((t, i) => (
            <li key={str(t.id) ?? i}>
              <span className="todo-box">☐</span> {str(t.content) ?? ''}
            </li>
          ))}
        </ul>
      )}
      <ErrorLine tool={tool} />
      {canExecute && status === 'done' && (
        <div className="plan-actions">
          <button
            className="btn primary"
            disabled={running}
            onClick={() => send({ type: 'plan/execute', tabId })}
            title="Resume this chat in Agent mode and implement the plan"
          >
            Run this plan
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- todo ----------

function TodoCard({ tool, status }: { tool: ToolCallInfo; status: ToolStatus }) {
  const todos = (Array.isArray(tool.args.todos) ? tool.args.todos : []).filter(isObj);
  const mark = (s?: string) => (/complete|done/i.test(s ?? '') ? '☑' : /progress/i.test(s ?? '') ? '◐' : '☐');
  return (
    <CardShell status={status} title={`Updated todos (${todos.length})`}>
      <ul className="todo-list">
        {todos.map((t, i) => (
          <li key={str(t.id) ?? i}>
            <span className="todo-box">{mark(str(t.status))}</span> {str(t.content) ?? ''}
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

// ---------- generic (mcp / unknown) ----------

function RawCard({ tool, status }: { tool: ToolCallInfo; status: ToolStatus }) {
  const label = tool.uiKind === 'mcp' ? `MCP: ${str(tool.args.toolName) ?? str(tool.args.name) ?? tool.name}` : tool.name;
  return (
    <CardShell status={status} title={label}>
      <ErrorLine tool={tool} />
      <pre>{JSON.stringify({ args: tool.args, result: tool.result }, null, 2)}</pre>
    </CardShell>
  );
}

export function ToolCard({ tool, status, canExecutePlan }: { tool: ToolCallInfo; status: ToolStatus; canExecutePlan?: boolean }) {
  switch (tool.uiKind) {
    case 'read':
      return <ReadCard tool={tool} status={status} />;
    case 'edit':
      return <EditCard tool={tool} status={status} />;
    case 'delete':
      return <DeleteCard tool={tool} status={status} />;
    case 'shell':
      return <ShellCard tool={tool} status={status} />;
    case 'search':
      return <SearchCard tool={tool} status={status} />;
    case 'plan':
      return <PlanCard tool={tool} status={status} canExecute={!!canExecutePlan} />;
    case 'mode':
      return (
        <div className={`mode-note ${status}`}>
          ⇄ {status === 'error' ? 'Mode switch failed' : `Switched to ${str(tool.args.targetModeId) ?? '?'} mode`}
        </div>
      );
    case 'todo':
      return <TodoCard tool={tool} status={status} />;
    default:
      return <RawCard tool={tool} status={status} />;
  }
}

export function UnknownCard({ raw }: { raw: unknown }) {
  const type = isObj(raw) ? [str(raw.type), str(raw.subtype)].filter(Boolean).join(':') || 'event' : 'line';
  return (
    <CardShell status="done" className="unknown" icon="?" title={<span className="muted">Unrecognized {type}</span>}>
      <pre>{typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)}</pre>
    </CardShell>
  );
}
