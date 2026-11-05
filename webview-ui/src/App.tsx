import { useEffect, useMemo, useRef, useState } from 'react';
import type { Mode } from '../../src/shared/events';
import { ChatHeader } from './components/ChatHeader';
import { CliBanner } from './components/CliBanner';
import { Composer } from './components/Composer';
import { ContextChips } from './components/ContextChips';
import { HelpPanel } from './components/HelpPanel';
import { Mascot } from './components/Mascot';
import { Notice } from './components/Notice';
import { RunMessage } from './components/RunMessage';
import { TabContext } from './components/tools/util';
import { RestoreIcon } from './sessions/icons';
import { useStore } from './state/store';
import { send } from './vscode';

/** Composer mode per tab, kept while switching tabs. */
const composerModes = new Map<string, Mode>();

const TIPS = [
  'Type /model to pick the right model for the job.',
  'Shift+Tab switches between Agent, Ask and Plan.',
  'Type @ to attach files and folders.',
  'Select code and press Ctrl+L to add it to the chat.',
  'Every change can be reviewed and reverted.',
  'Press ↑ in an empty box to recall your last message.',
];

export function App() {
  const { tabs, activeTabId, defaultMode, focusRequest, cli, models } = useStore();
  useStore((s) => s.tick); // re-render on streamed events
  const tab = activeTabId ? tabs[activeTabId] : undefined;
  const [mode, setMode] = useState<Mode>(defaultMode);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const modesSupported = cli.features?.modes ?? true;
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]!);

  useEffect(() => {
    if (tab) setMode(composerModes.get(tab.meta.id) ?? tab.meta.mode);
  }, [tab?.meta.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab) composerModes.set(tab.meta.id, mode);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Run this plan" switches the tab to Agent; mirror that in the composer.
  useEffect(() => {
    if (tab) setMode(tab.meta.mode);
  }, [tab?.meta.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Alt+N: new session. Switching sessions happens in the Session Manager (left sidebar).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        send({ type: 'tab/new' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the view pinned to the bottom while streaming, unless the user scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const running = !!tab?.meta.running;
  const queued = !!tab?.transcript.some((x) => x.role === 'run' && x.status === 'queued');
  const lastSent = useMemo(() => {
    const t = tab?.transcript ?? [];
    for (let i = t.length - 1; i >= 0; i--) {
      const it = t[i]!;
      if (it.role === 'user') return it.text;
    }
    return undefined;
  }, [tab?.transcript]);
  const latestRunId = useMemo(() => {
    const t = tab?.transcript ?? [];
    for (let i = t.length - 1; i >= 0; i--) if (t[i]!.role === 'run') return t[i]!.id;
    return undefined;
  }, [tab?.transcript]);
  // User messages from which "Restore code to before this message" can act.
  const restorable = useMemo(() => {
    const t = tab?.transcript ?? [];
    const ids = new Set<string>();
    let later = false;
    for (let i = t.length - 1; i >= 0; i--) {
      const it = t[i]!;
      if (it.role === 'run' && it.changes?.status === 'ready' && it.changes.files.some((f) => f.state !== 'reverted')) later = true;
      if (it.role === 'user' && later) ids.add(it.id);
    }
    return ids;
  }, [tab?.transcript]);
  const ctx = useMemo(() => ({ tabId: tab?.meta.id ?? '', cwd: tab?.meta.cwd, running }), [tab?.meta.id, tab?.meta.cwd, running]);

  return (
    <TabContext.Provider value={ctx}>
      <div className="app">
        <ChatHeader tab={tab?.meta} queued={queued} />
        <CliBanner cli={cli} />
        {tab?.meta.worktree && (
          <div className="worktree-banner">
            <span title={tab.meta.worktreePath}>
              ⎇ Worktree{tab.meta.worktreePath ? `: ${tab.meta.worktreePath.split(/[\\/]/).slice(-2).join('/')}` : ' (created on the next run)'}
            </span>
            {tab.meta.worktreePath && (
              <button className="link" onClick={() => send({ type: 'worktree/open', path: tab.meta.worktreePath! })}>
                Open in new window
              </button>
            )}
          </div>
        )}
        <div className="messages" ref={listRef} onScroll={onScroll}>
          {!tab || tab.transcript.length === 0 ? (
            <div className="empty">
              <Mascot size={56} />
              <p className="empty-tip">{tip}</p>
            </div>
          ) : (
            tab.transcript.map((item) =>
              item.role === 'user' ? (
                <div key={item.id} className="user-msg">
                  {item.chips && item.chips.length > 0 && <ContextChips chips={item.chips} readOnly />}
                  <div className="user-text">{item.text}</div>
                  {item.mode !== 'agent' && <span className="user-mode">{item.mode}</span>}
                  {restorable.has(item.id) && (
                    <button
                      className="restore-btn icon-btn"
                      disabled={running}
                      title="Restore code to before this message (asks first)"
                      aria-label="Restore code to before this message"
                      onClick={() => send({ type: 'checkpoint/restore', tabId: tab.meta.id, userMessageId: item.id })}
                    >
                      <RestoreIcon />
                    </button>
                  )}
                </div>
              ) : (
                <RunMessage key={item.id} run={item} view={tab.views[item.id]!} isLatest={item.id === latestRunId} />
              ),
            )
          )}
        </div>
        <HelpPanel />
        <Notice />
        <Composer
          key={tab?.meta.id ?? 'none'}
          tabId={tab?.meta.id}
          chips={tab?.chips ?? []}
          running={running}
          mode={mode}
          model={tab?.meta.model}
          models={models}
          modesSupported={modesSupported}
          worktreeSupported={cli.features?.worktree}
          worktree={tab?.meta.worktree}
          lastSent={lastSent}
          disabled={!tab || cli.state === 'notFound'}
          focusRequest={focusRequest}
          onModeChange={setMode}
          onModelChange={(model) => tab && send({ type: 'tab/setModel', tabId: tab.meta.id, model })}
          onSend={(text, chipIds) =>
            tab && send({ type: 'message/send', tabId: tab.meta.id, text, mode, model: tab.meta.model, chipIds })
          }
          onStop={() => tab && send({ type: 'run/stop', tabId: tab.meta.id })}
        />
      </div>
    </TabContext.Provider>
  );
}
