import { useEffect, useMemo, useRef, useState } from 'react';
import type { Mode } from '../../src/shared/events';
import { CliBanner } from './components/CliBanner';
import { Composer } from './components/Composer';
import { ContextChips } from './components/ContextChips';
import { HistoryView } from './components/HistoryView';
import { Notice } from './components/Notice';
import { RunMessage } from './components/RunMessage';
import { TabBar } from './components/TabBar';
import { TabContext } from './components/tools/util';
import { useStore } from './state/store';
import { send } from './vscode';

/** Composer mode per tab, kept while switching tabs. */
const composerModes = new Map<string, Mode>();

export function App() {
  const { tabs, activeTabId, defaultMode, focusRequest, cli, models, historyOpen } = useStore();
  useStore((s) => s.tick); // re-render on streamed events
  const tab = activeTabId ? tabs[activeTabId] : undefined;
  const [mode, setMode] = useState<Mode>(defaultMode);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const modesSupported = cli.features?.modes ?? true;

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
        <TabBar />
        <CliBanner cli={cli} />
        {historyOpen && <HistoryView />}
        <div className="messages" ref={listRef} onScroll={onScroll} hidden={historyOpen}>
          {!tab || tab.transcript.length === 0 ? (
            <div className="empty">
              <p>No chats yet.</p>
              <p className="muted">
                Select code and press <kbd>Ctrl+L</kbd> to add it, type <kbd>@</kbd> to attach files, or just type below.
              </p>
              <p className="muted">
                <b>Agent</b> edits files and runs commands, <b>Ask</b> is read-only, <b>Plan</b> proposes a plan you can then
                run. <kbd>Shift+Tab</kbd> cycles modes.
              </p>
            </div>
          ) : (
            tab.transcript.map((item) =>
              item.role === 'user' ? (
                <div key={item.id} className="user-msg">
                  <span className={`mode-badge ${item.mode}`}>{item.mode}</span>
                  {item.chips && <ContextChips chips={item.chips} readOnly />}
                  <div className="user-text">{item.text}</div>
                  {restorable.has(item.id) && (
                    <button
                      className="restore-btn link"
                      disabled={running}
                      title="Restore every file changed from this message on to how it was before (asks first)"
                      onClick={() => send({ type: 'checkpoint/restore', tabId: tab.meta.id, userMessageId: item.id })}
                    >
                      ↶ Restore code to before this message
                    </button>
                  )}
                </div>
              ) : (
                <RunMessage key={item.id} run={item} view={tab.views[item.id]!} isLatest={item.id === latestRunId} />
              ),
            )
          )}
        </div>
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
