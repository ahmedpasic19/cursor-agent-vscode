import type { RunChanges } from '../../../src/shared/protocol';
import { send } from '../vscode';
import { useTab } from './tools/util';

const STATUS_LABEL = { A: 'Added', M: 'Modified', D: 'Deleted' } as const;

/** Files changed by an Agent run, with diff / revert / keep (PLAN.md §5.6). */
export function ChangesCard({ runId, changes, runActive }: { runId: string; changes: RunChanges; runActive: boolean }) {
  const { tabId, running } = useTab();

  if (changes.status === 'unavailable') {
    return <div className="changes-note warn">⚠ {changes.message ?? 'No checkpoint for this run.'}</div>;
  }
  if (changes.status === 'pending' || runActive) {
    return <div className="changes-note">⟲ Checkpoint saved — changed files will be listed when the run finishes.</div>;
  }
  if (!changes.files.length) return <div className="changes-note">No files changed.</div>;

  const pending = changes.files.filter((f) => f.state === 'pending');
  const notReverted = changes.files.filter((f) => f.state !== 'reverted');
  const totalAdd = changes.files.reduce((n, f) => n + f.added, 0);
  const totalDel = changes.files.reduce((n, f) => n + f.removed, 0);

  return (
    <div className="changes-card">
      <div className="changes-header">
        <span className="changes-title">
          {changes.files.length} file{changes.files.length === 1 ? '' : 's'} changed
        </span>
        <span className="add-count">+{totalAdd}</span>
        <span className="del-count">−{totalDel}</span>
        <span className="spacer" />
        {notReverted.length > 0 && (
          <button
            className="btn secondary small"
            disabled={running}
            onClick={() => send({ type: 'changes/revertAll', tabId, runId })}
            title="Restore every file this run changed (asks first)"
          >
            Revert all
          </button>
        )}
        {pending.length > 0 && (
          <button className="btn primary small" onClick={() => send({ type: 'changes/keepAll', tabId, runId })}>
            Keep all
          </button>
        )}
      </div>
      <ul className="changes-list">
        {changes.files.map((f) => (
          <li key={f.path} className={`change-row state-${f.state}`}>
            <span className={`change-status s-${f.status}`} title={STATUS_LABEL[f.status]}>
              {f.status}
            </span>
            <button
              className="change-path link"
              onClick={() => send({ type: 'changes/openDiff', tabId, runId, path: f.path })}
              title={`Open diff: ${f.path}`}
            >
              <span className="change-name">{f.path.split('/').pop()}</span>
              <span className="change-dir">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
            </button>
            {f.foreign && (
              <span className="chip-flag" title="Also edited by another tab's run that overlapped this one. Revert all skips it.">
                other tab
              </span>
            )}
            {f.binary ? (
              <span className="muted small">binary</span>
            ) : (
              <span className="change-counts">
                <span className="add-count">+{f.added}</span> <span className="del-count">−{f.removed}</span>
              </span>
            )}
            {f.state === 'pending' ? (
              <span className="change-actions">
                <button
                  className="icon-btn small"
                  title="Revert this file"
                  aria-label={`Revert ${f.path}`}
                  disabled={running}
                  onClick={() => send({ type: 'changes/revertFile', tabId, runId, path: f.path })}
                >
                  ↶
                </button>
                <button
                  className="icon-btn small"
                  title="Keep this file"
                  aria-label={`Keep ${f.path}`}
                  onClick={() => send({ type: 'changes/keepFile', tabId, runId, path: f.path })}
                >
                  ✓
                </button>
              </span>
            ) : (
              <span className={`change-state ${f.state}`}>{f.state}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
